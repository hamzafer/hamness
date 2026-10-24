import type { HamnessDb } from "../db/open.ts";
import type { TaskEvent } from "../events/types.ts";
import type { GuardedCall, SafetyVerdict } from "../safety/index.ts";
import type { GhRunner } from "./checkers/index.ts";
import { parseClaim } from "./claims.ts";
import { decideGate, type GateResult } from "./gate.ts";
import { proveClaim } from "./proof.ts";
import { TaskStore } from "./store.ts";
import type { CheckResult, TaskView } from "./types.ts";

/** A task event before the hub stamps it with the session and its sequence number. */
export type TaskEventBody = TaskEvent;

/** A task action that does not fit the session's task state (an HTTP 409, a tool error). */
export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export interface SessionTasksOptions {
  db: HamnessDb;
  sessionId: string;
  cwd: string;
  emit: (event: TaskEventBody) => void;
  /** The session's safety check; a `prove` command re-run passes it as a `bash` call. */
  safety: (call: GuardedCall) => Promise<SafetyVerdict>;
  gh: GhRunner;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The user config's `proof.allowPrivateUrls`, read on each `prove url`. Default false. */
  allowPrivateUrls?: () => boolean;
}

const GOAL_MAX = 200;

function goalOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > GOAL_MAX ? `${line.slice(0, GOAL_MAX - 1)}…` : line || "(empty prompt)";
}

/**
 * One session's tasks and the outcome rules (ADRs 0004, 0005, 0012):
 *
 * - A turn with no open task gets an implicit task named after the prompt.
 * - `task_start` (agent) and `/task` (user) open a task, or promote the turn's implicit one.
 * - `task_done`: `verified` with at least one passed piece of evidence, else `unverified`.
 * - `/override` (user only): an open or unverified task becomes `overridden`.
 * - `/abandon` (user only): the open task becomes `abandoned`.
 * - At turn end an implicit task still open closes: `verified` with passing evidence,
 *   `unverified` with failed evidence, file edits or subagents, and is dropped when it had none.
 *
 * Rows the hub stores count toward `attributionId()`: the open task, or the one closed
 * earlier in this turn, so the wrap-up of a task still counts toward it.
 */
export class SessionTasks {
  private readonly store: TaskStore;
  /** The task this turn's rows count toward. */
  private current: string | undefined;

  constructor(private readonly opts: SessionTasksOptions) {
    this.store = new TaskStore(opts.db);
    const open = this.store.openFor(opts.sessionId);
    if (open) {
      this.current = open.id;
      // An implicit task still open from before a restart: its turn is over.
      if (open.implicit) this.endTurn();
    }
  }

  attributionId(): string | undefined {
    return this.current;
  }

  /** The current task, or the session's last one. */
  view(): TaskView | undefined {
    const id = this.current ?? this.store.latestFor(this.opts.sessionId);
    return id ? this.store.view(id) : undefined;
  }

  beginTurn(prompt: string): void {
    const open = this.openTask();
    if (open) return;
    this.current = this.store.open(this.opts.sessionId, goalOf(prompt), true);
    this.emitStart(this.current);
  }

  /** Whether the open (or last) task would be verified now, and why (`gate.ts`). */
  gate(taskId = this.current ?? this.store.latestFor(this.opts.sessionId)): GateResult {
    if (!taskId) return { verified: false, reason: "there is no task" };
    return decideGate(this.store.gateEvidence(taskId), this.store.lastFileChange(taskId));
  }

  endTurn(): void {
    const open = this.openTask();
    if (open?.implicit) {
      if (this.gate(open.id).verified) this.closeAs(open.id, "verified");
      else if (
        this.store.failedCount(open.id) > 0 ||
        this.store.changedFiles(open.id) ||
        this.store.hasSubagents(open.id)
      )
        this.closeAs(open.id, "unverified");
      else {
        this.store.drop(open.id);
        this.opts.emit({ type: "task.drop", taskId: open.id });
      }
    }
    // Next turn starts fresh unless an explicit task is still open.
    if (!this.openTask()) this.current = undefined;
  }

  /** `task_start(goal)` or `/task goal`. */
  start(goal: string): TaskView {
    const text = goal.trim();
    if (!text) throw new TaskStateError("a task needs a goal");
    const open = this.openTask();
    if (open && !open.implicit) {
      const current = this.store.view(open.id);
      throw new TaskStateError(
        `a task is already open: "${current?.goal}". Finish it with task_done (or the user's /abandon) first.`,
      );
    }
    let id: string;
    if (open) {
      id = open.id;
      this.store.promote(id, goalOf(text));
    } else {
      id = this.store.open(this.opts.sessionId, goalOf(text), false);
    }
    this.current = id;
    return this.emitStart(id);
  }

  /** `task_done(summary)`: the proof gate. */
  done(summary: string): TaskView {
    const open = this.requireOpen("call task_start first");
    const gate = this.gate(open.id);
    const task = this.closeAs(open.id, gate.verified ? "verified" : "unverified", {
      summary: summary.trim() || undefined,
    });
    return gate.verified ? task : { ...task, unverifiedReason: gate.reason };
  }

  /** `/override [reason]`: the user accepts a task without proof. */
  override(reason?: string): TaskView {
    const open = this.openTask();
    const target = open?.id ?? this.lastClosed();
    const view = target ? this.store.view(target) : undefined;
    if (!view || (view.outcome !== "open" && view.outcome !== "unverified")) {
      throw new TaskStateError(
        view
          ? `the last task is ${view.outcome}; only an open or unverified task can be overridden`
          : "there is no task to override",
      );
    }
    return this.closeAs(view.id, "overridden", { reason: reason?.trim() || undefined });
  }

  /** `/abandon [reason]`. */
  abandon(reason?: string): TaskView {
    const open = this.requireOpen("there is no open task to abandon");
    return this.closeAs(open.id, "abandoned", { reason: reason?.trim() || undefined });
  }

  /**
   * `prove(...)`: validates the claim (refusing any result field), stores it and has the
   * checker decide. `toolCallId` is the `prove` call's `tool_calls` row.
   */
  async prove(
    input: unknown,
    opts: { toolCallId?: string; signal?: AbortSignal } = {},
  ): Promise<{ evidenceId: string; result: CheckResult; task: TaskView }> {
    const parsed = parseClaim(input);
    if (!parsed.ok) throw new TaskStateError(parsed.error);
    const open = this.requireOpen("call task_start first, then prove");
    const { evidenceId, result } = await proveClaim(
      this.opts.db,
      this.store,
      {
        taskId: open.id,
        claim: parsed.claim,
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      },
      {
        sessionId: this.opts.sessionId,
        cwd: this.opts.cwd,
        toolCallId: opts.toolCallId ?? "",
        taskStartedAt: this.store.startedAt(open.id),
        writtenByAgent: (path) => this.store.writtenPaths(open.id, this.opts.cwd).has(path),
        safety: this.opts.safety,
        gh: this.opts.gh,
        fetch: this.opts.fetch,
        allowPrivateUrls: this.opts.allowPrivateUrls?.() ?? false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    const counts = this.store.evidenceCounts(open.id);
    this.opts.emit({
      type: "task.evidence",
      taskId: open.id,
      evidenceId,
      kind: parsed.claim.kind,
      status: result.status,
      summary: result.summary,
      ...counts,
    });
    return { evidenceId, result, task: this.store.view(open.id) as TaskView };
  }

  private openTask() {
    return this.store.openFor(this.opts.sessionId);
  }

  private requireOpen(hint: string) {
    const open = this.openTask();
    if (!open) throw new TaskStateError(`no open task: ${hint}`);
    return open;
  }

  private lastClosed(): string | undefined {
    return this.store.latestFor(this.opts.sessionId);
  }

  private closeAs(
    id: string,
    outcome: "verified" | "unverified" | "overridden" | "abandoned",
    opts: { summary?: string | undefined; reason?: string | undefined } = {},
  ): TaskView {
    this.store.close(id, outcome, {
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    const task = this.store.view(id) as TaskView;
    this.opts.emit({ type: "task.end", task });
    return task;
  }

  private emitStart(id: string): TaskView {
    const task = this.store.view(id) as TaskView;
    this.opts.emit({ type: "task.start", task });
    return task;
  }
}
