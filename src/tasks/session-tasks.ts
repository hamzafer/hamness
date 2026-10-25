import { homedir } from "node:os";
import type { HamnessDb } from "../db/open.ts";
import type { TaskEvent } from "../events/types.ts";
import type { GuardedCall, SafetyVerdict } from "../safety/index.ts";
import { type GhRunner, type GitRunner, runGit } from "./checkers/index.ts";
import { parseClaim } from "./claims.ts";
import { decideGate, type GateResult } from "./gate.ts";
import { proveClaim } from "./proof.ts";
import { cdOutsideProblem } from "./proof-shape.ts";
import { TaskStore } from "./store.ts";
import type { CheckResult, CheckView, EvidenceClaim, TaskView } from "./types.ts";

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
  /** `git` for CI evidence (is the commit in HEAD's history?). Default: the real one. */
  git?: GitRunner;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The git branch checked out in `cwd`, recorded when a task opens. Default: asks git. */
  branchOf?: (cwd: string) => string | undefined;
  /** The user config's `proof.allowPrivateUrls`, read on each `prove url`. Default false. */
  allowPrivateUrls?: () => boolean;
}

const GOAL_MAX = 200;
/** Checks a snapshot carries: as many as the full-screen rail keeps. */
const CHECKS_KEPT = 20;

/** A claim in one line, for the rail: the command, path, URL or PR / commit. */
function claimLabel(claim: EvidenceClaim): string {
  switch (claim.kind) {
    case "command":
      return claim.command;
    case "file":
      return claim.path;
    case "url":
      return claim.url;
    case "ci":
      return claim.pr !== undefined ? `PR ${claim.pr}` : `commit ${claim.commit}`;
  }
}

/** The branch checked out in `cwd`; undefined outside a repo or on a detached HEAD. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const name = r.stdout.toString().trim();
    return r.exitCode === 0 && name && name !== "HEAD" ? name : undefined;
  } catch {
    return undefined;
  }
}

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
    // One SessionTasks per live session: no call of this session is running yet.
    this.store.closeStaleToolCalls(opts.sessionId);
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

  /** The open task only: spend outside a turn (a `/compact`) never goes to a closed one. */
  openTaskId(): string | undefined {
    return this.openTask()?.id;
  }

  /** The current task, or the session's last one. */
  view(): TaskView | undefined {
    const id = this.current ?? this.store.latestFor(this.opts.sessionId);
    return id ? this.store.view(id) : undefined;
  }

  /** The session's last `limit` finished checks, oldest first, for a reattaching rail. */
  checks(limit = CHECKS_KEPT): CheckView[] {
    return this.store.checkedEvidence(this.opts.sessionId, limit).map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.claim.kind,
      label: claimLabel(e.claim),
      status: e.status,
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
      startedAt: e.createdAt,
      ...(e.checkedAt !== undefined ? { endedAt: e.checkedAt } : {}),
    }));
  }

  beginTurn(prompt: string): void {
    const open = this.openTask();
    if (open) return;
    this.current = this.store.open(this.opts.sessionId, goalOf(prompt), true, this.branch());
    this.emitStart(this.current);
  }

  /** Whether the open (or last) task would be verified now, and why (`gate.ts`). */
  gate(taskId = this.current ?? this.store.latestFor(this.opts.sessionId)): GateResult {
    if (!taskId) return { verified: false, reason: "there is no task" };
    return decideGate(
      this.store.gateEvidence(taskId),
      this.store.lastFileChange(taskId, this.opts.cwd),
    );
  }

  endTurn(): void {
    const open = this.openTask();
    if (open?.implicit) {
      if (this.gate(open.id).verified) this.closeAs(open.id, "verified");
      else if (this.didWork(open.id)) this.closeAs(open.id, "unverified");
      else this.drop(open.id);
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
      id = this.store.open(this.opts.sessionId, goalOf(text), false, this.branch());
    }
    this.current = id;
    return this.emitStart(id);
  }

  /**
   * `task_done(summary)`: the proof gate. A task that did nothing to prove (no failed evidence,
   * no file changes, no subagents) and passed no check is dropped like a chat turn (ADR 0012).
   */
  done(summary: string): TaskView {
    const open = this.requireOpen("call task_start first");
    const gate = this.gate(open.id);
    if (!gate.verified && !this.didWork(open.id)) {
      const view = this.store.view(open.id) as TaskView;
      this.drop(open.id);
      return { ...view, dropped: true };
    }
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
    if (parsed.claim.kind === "command") {
      const problem = cdOutsideProblem(parsed.claim.command, this.opts.cwd, homedir());
      if (problem) throw new TaskStateError(`not proof: ${problem}`);
    }
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
        writtenPaths: () => this.store.writtenPaths(open.id, this.opts.cwd),
        safety: this.opts.safety,
        gh: this.opts.gh,
        git: this.opts.git ?? runGit,
        fetch: this.opts.fetch,
        allowPrivateUrls: this.opts.allowPrivateUrls?.() ?? false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      {
        onStart: (id) =>
          this.opts.emit({
            type: "check.start",
            taskId: open.id,
            evidenceId: id,
            kind: parsed.claim.kind,
            label: claimLabel(parsed.claim),
          }),
      },
    );
    this.opts.emit({
      type: "check.end",
      taskId: open.id,
      evidenceId,
      status: result.status,
      summary: result.summary,
    });
    if (parsed.claim.kind === "ci" && result.status === "passed") {
      const { prUrl, commitSha } = result.details;
      this.store.setLinks(open.id, {
        ...(typeof prUrl === "string" ? { prUrl } : {}),
        ...(typeof commitSha === "string" ? { commitSha } : {}),
      });
    }
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

  /** Work that went unproven: failed evidence, file changes (edit, write, bash writes) or subagents. */
  private didWork(id: string): boolean {
    return (
      this.store.failedCount(id) > 0 ||
      this.store.changedFiles(id, this.opts.cwd) ||
      this.store.hasSubagents(id)
    );
  }

  /** Deletes a task that did nothing; its rows stay, with no task (ADR 0012). */
  private drop(id: string): void {
    this.store.drop(id);
    if (this.current === id) this.current = undefined;
    this.opts.emit({ type: "task.drop", taskId: id });
  }

  private branch(): string | undefined {
    return (this.opts.branchOf ?? gitBranch)(this.opts.cwd);
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
