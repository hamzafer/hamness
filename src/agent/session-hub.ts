import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ClaudeHooks, claudePermissionMode, type HookSession } from "../compat/hooks.ts";
import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type {
  AgentEvent,
  ApprovalDecision,
  JudgeState,
  PendingApproval,
  SafetyMode,
  SessionInfo,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";
import { costMicros } from "../models/prices.ts";
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  allowAll,
  redactArgs,
  type SafetyCheck,
} from "../safety/index.ts";
import { type GhRunner, runGh } from "../tasks/checkers/index.ts";
import { SessionTasks } from "../tasks/session-tasks.ts";
import { PROOF_GATE_PROMPT, taskTools } from "../tasks/tools.ts";
import type { TaskAction, TaskView } from "../tasks/types.ts";
import { envKeyHint } from "./keys.ts";
import {
  keyFilePath,
  listModels,
  type ModelChoice,
  type ModelInfo,
  parseModelSpec,
} from "./models.ts";
import { type AgentRunner, type RunnerEvent, startAgentRunner } from "./runner.ts";
import { ChatStore } from "./store.ts";

/** Distributive Omit, so each event keeps its own fields. */
type EventBody = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "sessionId" | "seq">
    : never
  : never;

export interface SessionHubOptions {
  db: HamnessDb;
  /** hamness's data dir; Pi's config and session files live under `<dataDir>/pi`. */
  dataDir: string;
  /** Resolved on first use, so the daemon starts without an API key. */
  models: () => Promise<ModelChoice>;
  safety?: SafetyCheck;
  /** The safety mode for a cwd, shown to clients (the yolo banner). */
  safetyMode?: (cwd: string) => SafetyMode | undefined;
  /** The judge's state per session, and `/judge resume` (auto mode only). */
  judge?: { state(sessionId: string): JudgeState; resume(sessionId: string): boolean };
  publish: (event: AgentEvent) => void;
  contextFiles?: boolean;
  /** How `ci` evidence runs `gh`, and how `url` evidence fetches. Tests pass fakes. */
  gh?: GhRunner;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Claude Code hooks for session starts, prompts, tool results and stops (PreToolUse is in `safety`). */
  hooks?: Omit<ClaudeHooks, "preToolUse">;
}

/** Stop hooks may continue a turn this many times in a row (Claude Code's cap). */
export const STOP_HOOK_CAP = 8;

/** Pi's "No API key" error points at its own `/login`; say what works in hamness instead. */
function explainError(message: string, dataDir: string): string {
  const missing = /No API key (?:found )?for ([\w-]+)/.exec(message);
  if (!missing) return message;
  const provider = missing[1] ?? "anthropic";
  return `No API key for ${provider}. Set ${envKeyHint(provider)}, or run \`hamness keys set ${provider}\` (stored in ${keyFilePath(dataDir)}, mode 0600), then restart the daemon.`;
}

/** A model the session cannot switch to: not in the catalog, or no credentials for it. */
export class ModelSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSwitchError";
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super("the session is already running a prompt");
    this.name = "SessionBusyError";
  }
}

interface LiveSession {
  id: string;
  agentId: string;
  cwd: string;
  runner: AgentRunner;
  /** The Pi runtime (and starting model) the session was built with; switches use its catalog. */
  models: ModelChoice;
  seq: number;
  busy: boolean;
  /** Assistant message rows by the runner's key, with their text so far. */
  replies: Map<string, { rowId: string; text: string; done: boolean }>;
  /** The latest assistant message row; tool calls after it belong to it. */
  currentReplyRow: string | undefined;
  /** `tool_calls` row ids by Pi's tool call id. */
  tools: Map<string, string>;
  denied: Map<string, string>;
  /** Tool calls waiting for the user, by approval id. */
  approvals: Map<string, PendingEntry>;
  /** The session's tasks: the per-turn task, the agent's task tools, the proof gate. */
  tasks: SessionTasks;
  /** SessionStart hooks; the first prompt waits for them. */
  ready: Promise<void>;
  /** SessionStart hook context and notice, for the first prompt. */
  startContext?: string | undefined;
  startNotice?: string | undefined;
  /** The text of the last reply, for Stop hooks. */
  lastReply: string;
  /** True while a Stop hook keeps the turn going; `stopStreak` counts it (tool calls reset it). */
  stopActive: boolean;
  stopStreak: number;
  /** Bumped by abort, so a Stop hook that answers after it doesn't restart the run. */
  runGen: number;
}

interface PendingEntry {
  approval: PendingApproval;
  settle: (answer: ApprovalAnswer) => void;
}

/**
 * Owns the live sessions: one main agent per working directory, kept running after
 * clients detach. Turns runner events into stored rows and published events.
 */
export class SessionHub {
  private readonly store: ChatStore;
  private readonly byId = new Map<string, LiveSession>();
  private readonly byCwd = new Map<string, Promise<LiveSession>>();
  private readonly safety: SafetyCheck;

  constructor(private readonly opts: SessionHubOptions) {
    this.store = new ChatStore(opts.db);
    this.safety = opts.safety ?? allowAll;
  }

  /** The live session for `cwd`, created if there is none. */
  async attach(cwd: string): Promise<SessionSnapshot> {
    let pending = this.byCwd.get(cwd);
    if (!pending) {
      pending = this.create(cwd);
      this.byCwd.set(cwd, pending);
      pending.catch(() => this.byCwd.delete(cwd));
    }
    return this.snapshotOf(await pending);
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const live = this.byId.get(sessionId);
    return live && this.snapshotOf(live);
  }

  /** Starts a prompt and returns the user message id; the reply streams as events. */
  prompt(sessionId: string, text: string): string | undefined {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    if (live.busy) throw new SessionBusyError();

    live.tasks.beginTurn(text);
    const messageId = this.store.addMessage(this.ids(live), "user", text);
    this.emit(live, { type: "agent.message.start", messageId, role: "user" });
    this.emit(live, { type: "agent.message.end", messageId, role: "user", text });
    this.setBusy(live, true);
    this.send(live, text).catch((err: unknown) => this.failRun(live, err));
    return messageId;
  }

  private failRun(live: LiveSession, err: unknown): void {
    const message = (err as Error).message ?? String(err);
    this.emit(live, { type: "agent.error", message: explainError(message, this.opts.dataDir) });
    live.tasks.endTurn();
    this.setBusy(live, false);
  }

  private hookSession(live: LiveSession): HookSession {
    const file = live.runner.sessionFile;
    return {
      sessionId: live.id,
      cwd: live.cwd,
      ...(file ? { transcriptPath: file } : {}),
      permissionMode: claudePermissionMode(this.opts.safetyMode?.(live.cwd)),
    };
  }

  /** Runs UserPromptSubmit hooks, then sends the prompt (with any hook context) to the model. */
  private async send(live: LiveSession, text: string): Promise<void> {
    live.stopActive = false;
    live.stopStreak = 0;
    const hooks = this.opts.hooks;
    if (!hooks) return live.runner.prompt(text);
    await live.ready;
    if (live.startNotice) {
      this.emit(live, { type: "agent.notice", message: live.startNotice });
      live.startNotice = undefined;
    }
    const submitted = await hooks.userPromptSubmit(this.hookSession(live), text);
    if (submitted.blocked) {
      this.emit(live, {
        type: "agent.notice",
        message: `A UserPromptSubmit hook blocked the prompt: ${submitted.blocked}`,
      });
      live.tasks.endTurn();
      this.setBusy(live, false);
      return;
    }
    const extra = [
      live.startContext && `SessionStart hook additional context:\n${live.startContext}`,
      submitted.context && `UserPromptSubmit hook additional context:\n${submitted.context}`,
    ].filter(Boolean);
    live.startContext = undefined;
    const body = extra.length
      ? `${text}\n\n<system-reminder>\n${extra.join("\n\n")}\n</system-reminder>`
      : text;
    await live.runner.prompt(body);
  }

  /** The run settled: Stop hooks may keep it going, up to `STOP_HOOK_CAP` times in a row. */
  private async afterRun(live: LiveSession, aborted: boolean): Promise<void> {
    const hooks = this.opts.hooks;
    const gen = live.runGen;
    let reason: string | undefined;
    if (hooks && !aborted) {
      reason = (
        await hooks.stop(this.hookSession(live), {
          stopHookActive: live.stopActive,
          lastAssistantMessage: live.lastReply,
        })
      ).continueWith;
    }
    if (reason && gen === live.runGen) {
      if (live.stopStreak < STOP_HOOK_CAP) {
        live.stopActive = true;
        live.stopStreak += 1;
        live.runner
          .prompt(`Stop hook feedback:\n${reason}`)
          .catch((err: unknown) => this.failRun(live, err));
        return;
      }
      this.emit(live, {
        type: "agent.notice",
        message: `Stop hooks continued the turn ${STOP_HOOK_CAP} times in a row; ending it.`,
      });
    }
    live.stopActive = false;
    live.currentReplyRow = undefined;
    live.tasks.endTurn();
    this.setBusy(live, false);
  }

  /** Announces a session's new judge state to its clients. */
  judgeChanged(sessionId: string, state: JudgeState, reason: string): void {
    const live = this.byId.get(sessionId);
    if (live) this.emit(live, { type: "safety.judge", state, reason });
  }

  /** Unpauses the session's judge. Undefined when there is no such session or no judge. */
  resumeJudge(sessionId: string): JudgeState | undefined {
    const judge = this.opts.judge;
    if (!this.byId.has(sessionId) || !judge) return undefined;
    judge.resume(sessionId);
    return judge.state(sessionId);
  }

  /**
   * A user action on the session's task (`/task`, `/override`, `/abandon`). Never reachable
   * from the agent's tools. Throws `TaskStateError` when the task state doesn't allow it.
   */
  taskAction(sessionId: string, action: TaskAction): TaskView | undefined {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    switch (action.kind) {
      case "start":
        return live.tasks.start(action.goal);
      case "override":
        return live.tasks.override(action.reason);
      case "abandon":
        return live.tasks.abandon(action.reason);
    }
  }

  /** The models a session can switch to: Pi's catalog, for providers with credentials. */
  async models(): Promise<ModelInfo[]> {
    const first = this.byId.values().next().value as LiveSession | undefined;
    const runtime = first?.models.runtime ?? (await this.opts.models()).runtime;
    return listModels(runtime);
  }

  /**
   * Switches the session's model (`provider/id`); the next model call uses it, and each call
   * records its own model. Throws `ModelSwitchError` or `SessionBusyError`.
   */
  async setModel(sessionId: string, spec: string): Promise<SessionSnapshot | undefined> {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    if (live.busy) throw new SessionBusyError();
    const parsed = parseModelSpec(spec);
    const model = parsed && live.models.runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new ModelSwitchError(`unknown model ${spec.trim() || "(empty)"}`);
    try {
      await live.runner.setModel(model);
    } catch (err) {
      throw new ModelSwitchError(explainError((err as Error).message, this.opts.dataDir));
    }
    this.store.setModel(this.ids(live), live.runner.model);
    this.emit(live, { type: "agent.model", model: live.runner.model });
    return this.snapshotOf(live);
  }

  async abort(sessionId: string): Promise<boolean> {
    const live = this.byId.get(sessionId);
    if (!live) return false;
    // Pi waits for a pending tool_call handler, so answer the approvals first.
    live.runGen += 1;
    this.cancelApprovals(live);
    await live.runner.abort();
    return true;
  }

  /** Answers a pending approval. False when there is no such approval (unknown or answered). */
  answerApproval(approvalId: string, decision: ApprovalDecision): boolean {
    for (const live of this.byId.values()) {
      const entry = live.approvals.get(approvalId);
      if (entry) {
        entry.settle({ decision, by: "user" });
        return true;
      }
    }
    return false;
  }

  stop(): void {
    for (const live of this.byId.values()) {
      this.cancelApprovals(live);
      live.runner.dispose();
    }
    this.byId.clear();
    this.byCwd.clear();
  }

  /**
   * The cwd's last session from before a daemon restart, when SQLite has its rows and Pi
   * still has its JSONL (so the model gets the conversation back as context).
   */
  private resumable(cwd: string, sessionDir: string) {
    const last = this.store.latestSession(cwd);
    if (!last) return undefined;
    const file = SessionManager.findById(cwd, last.piSessionId, sessionDir);
    return file ? { ...last, file } : undefined;
  }

  private async create(cwd: string): Promise<LiveSession> {
    const base = await this.opts.models();
    const sessionDir = join(this.opts.dataDir, "pi", "sessions");
    const resume = this.resumable(cwd, sessionDir);
    const saved = resume?.model ? parseModelSpec(resume.model) : undefined;
    const savedModel = saved && base.runtime.getModel(saved.provider, saved.id);
    const models: ModelChoice = savedModel ? { ...base, model: savedModel } : base;
    const model = `${models.model.provider}/${models.model.id}`;
    // `live` is filled in before the runner can emit anything: events only follow a prompt.
    let live: LiveSession | undefined;
    const ready = (): LiveSession => {
      if (!live) throw new Error("session not ready");
      return live;
    };
    const runner = await startAgentRunner({
      cwd,
      agentDir: join(this.opts.dataDir, "pi"),
      sessionDir,
      ...(resume ? { resumeFile: resume.file } : {}),
      models,
      contextFiles: this.opts.contextFiles ?? true,
      systemPromptAppend: [PROOF_GATE_PROMPT],
      tools: taskTools({
        start: (goal) => ready().tasks.start(goal),
        done: (summary) => ready().tasks.done(summary),
        prove: (input, piId, signal) => {
          const l = ready();
          const toolCallId = l.tools.get(piId);
          return l.tasks.prove(input, {
            ...(toolCallId ? { toolCallId } : {}),
            ...(signal ? { signal } : {}),
          });
        },
      }),
      onEvent: (e) => live && this.onRunnerEvent(live, e),
      guard: async (call) => {
        if (!live) return { allow: false, reason: "session not ready" };
        const toolCallId = this.toolRow(live, call.toolCallId, call.tool, call.args);
        try {
          const target = live;
          const verdict = await this.safety(
            {
              sessionId: live.id,
              toolCallId,
              tool: call.tool,
              args: call.args,
              cwd: live.cwd,
              ...(live.runner.sessionFile ? { transcriptPath: live.runner.sessionFile } : {}),
            },
            { cwd: live.cwd, askUser: (req) => this.requestApproval(target, req) },
          );
          return verdict;
        } catch (err) {
          return { allow: false, reason: `safety check failed: ${(err as Error).message}` };
        }
      },
      ...(this.opts.hooks ? { afterTool: (call) => this.postToolHooks(live, call) } : {}),
    });
    const { sessionId, agentId } = resume
      ? { sessionId: resume.sessionId, agentId: resume.agentId }
      : this.store.createSession(cwd, model, runner.piSessionId);
    const tasks = new SessionTasks({
      db: this.opts.db,
      sessionId,
      cwd,
      emit: (e) => live && this.emit(live, e),
      // A `prove` command re-run is checked like a bash call, approvals included.
      safety: (call) => {
        const target = ready();
        return this.safety(call, {
          cwd,
          askUser: (req) => this.requestApproval(target, req),
        });
      },
      gh: this.opts.gh ?? runGh,
      fetch: this.opts.fetch ?? ((input, init) => fetch(input, init)),
    });
    live = {
      id: sessionId,
      agentId,
      cwd,
      runner,
      models: base,
      seq: 0,
      busy: false,
      replies: new Map(),
      currentReplyRow: undefined,
      tools: new Map(),
      denied: new Map(),
      approvals: new Map(),
      tasks,
      ready: Promise.resolve(),
      lastReply: "",
      stopActive: false,
      stopStreak: 0,
      runGen: 0,
    };
    live.ready = this.sessionStartHooks(live, resume ? "resume" : "startup", model);
    this.byId.set(sessionId, live);
    return live;
  }

  private async sessionStartHooks(
    live: LiveSession,
    source: "startup" | "resume",
    model: string,
  ): Promise<void> {
    const hooks = this.opts.hooks;
    if (!hooks) return;
    try {
      const started = await hooks.sessionStart(this.hookSession(live), { source, model });
      if (started.context) live.startContext = started.context;
      if (started.notice) live.startNotice = started.notice;
    } catch {
      // A hook problem never keeps the session from starting.
    }
  }

  /** PostToolUse hooks; their feedback goes next to the tool's result. */
  private async postToolHooks(
    live: LiveSession | undefined,
    call: {
      toolCallId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      isError: boolean;
    },
  ): Promise<string | undefined> {
    const hooks = this.opts.hooks;
    if (!hooks || !live || call.isError) return undefined;
    const r = await hooks.postToolUse(this.hookSession(live), {
      tool: call.tool,
      args: call.args,
      toolUseId: live.tools.get(call.toolCallId) ?? call.toolCallId,
      output: call.output,
    });
    return r.context && `PostToolUse hook feedback:\n${r.context}`;
  }

  private snapshotOf(live: LiveSession): SessionSnapshot {
    const streaming = new Map(
      [...live.replies.values()].filter((r) => !r.done).map((r) => [r.rowId, r.text]),
    );
    const items = this.store.transcript(live.id).map((item): TranscriptItem => {
      if (item.kind !== "message") return item;
      const partial = streaming.get(item.id);
      return partial === undefined ? item : { ...item, text: partial, streaming: true };
    });
    const context = live.runner.contextUsage();
    const task = live.tasks.view();
    return {
      session: this.info(live),
      seq: live.seq,
      items,
      agents: this.store.agentTotals(live.id),
      ...(task ? { task } : {}),
      ...(context ? { context } : {}),
      approvals: [...live.approvals.values()].map((e) => e.approval),
    };
  }

  private info(live: LiveSession): SessionInfo {
    const mode = this.opts.safetyMode?.(live.cwd);
    const judge = mode === "auto" ? this.opts.judge?.state(live.id) : undefined;
    return {
      id: live.id,
      cwd: live.cwd,
      model: live.runner.model,
      busy: live.busy,
      mainAgentId: live.agentId,
      ...(mode ? { mode } : {}),
      ...(judge ? { judge } : {}),
    };
  }

  /** Publishes an approval request and waits for an answer, the timeout or an abort. */
  private requestApproval(live: LiveSession, req: ApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      const approval: PendingApproval = {
        id: newId(),
        toolCallId: req.toolCallId,
        tool: req.tool,
        args: req.args,
        reason: req.reason,
        suggestions: req.suggestions,
        expiresAt: Date.now() + req.timeoutMs,
      };
      const timer = setTimeout(
        () => settle({ decision: "deny", by: "timeout" }),
        Math.min(req.timeoutMs, 2_147_483_647),
      );
      const settle = (answer: ApprovalAnswer) => {
        if (!live.approvals.delete(approval.id)) return;
        clearTimeout(timer);
        this.emit(live, {
          type: "safety.approval.resolved",
          approvalId: approval.id,
          decision: answer.decision === "deny" ? "deny" : "allow",
          by: answer.by,
        });
        resolve(answer);
      };
      live.approvals.set(approval.id, { approval, settle });
      this.emit(live, { type: "safety.approval.request", approval });
    });
  }

  private cancelApprovals(live: LiveSession): void {
    for (const entry of [...live.approvals.values()])
      entry.settle({ decision: "deny", by: "abort" });
  }

  /** Row ids for what the session stores now: its rows count toward the current task. */
  private ids(live: LiveSession) {
    return { sessionId: live.id, agentId: live.agentId, taskId: live.tasks.attributionId() };
  }

  private emit(live: LiveSession, body: EventBody): void {
    live.seq += 1;
    this.opts.publish({
      ...body,
      sessionId: live.id,
      agentId: live.agentId,
      seq: live.seq,
    } as AgentEvent);
  }

  private setBusy(live: LiveSession, busy: boolean): void {
    if (live.busy === busy) return;
    live.busy = busy;
    this.emit(live, { type: "agent.status", busy });
  }

  /** The `tool_calls` row for a Pi tool call, created (and announced) on first sight. */
  private toolRow(
    live: LiveSession,
    piId: string,
    tool: string,
    rawArgs: Record<string, unknown>,
  ): string {
    const existing = live.tools.get(piId);
    if (existing) return existing;
    const args = redactArgs(rawArgs);
    const messageId = live.currentReplyRow;
    const id = this.store.addToolCall(this.ids(live), {
      messageId,
      tool,
      argsJson: JSON.stringify(args),
    });
    live.tools.set(piId, id);
    this.emit(live, {
      type: "agent.tool.start",
      toolCallId: id,
      ...(messageId ? { messageId } : {}),
      tool,
      args,
    });
    return id;
  }

  private onRunnerEvent(live: LiveSession, e: RunnerEvent): void {
    switch (e.type) {
      case "assistant.start": {
        const rowId = this.store.addMessage(this.ids(live), "assistant", null);
        live.replies.set(e.key, { rowId, text: "", done: false });
        live.currentReplyRow = rowId;
        this.emit(live, { type: "agent.message.start", messageId: rowId, role: "assistant" });
        return;
      }
      case "assistant.delta": {
        const reply = live.replies.get(e.key);
        if (!reply) return;
        reply.text += e.text;
        this.emit(live, { type: "agent.message.delta", messageId: reply.rowId, text: e.text });
        return;
      }
      case "assistant.end": {
        const reply = live.replies.get(e.key);
        if (!reply) return;
        reply.text = e.text;
        reply.done = true;
        live.lastReply = e.text;
        this.store.setMessageContent(reply.rowId, e.text);
        const priced = costMicros(e.model, e.usage);
        const cost = priced ?? Math.round(e.piCostUsd * 1_000_000);
        const modelCallId = this.store.addModelCall(this.ids(live), {
          messageId: reply.rowId,
          provider: e.provider,
          model: e.model,
          usage: e.usage,
          costMicros: cost,
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        });
        this.emit(live, {
          type: "agent.message.end",
          messageId: reply.rowId,
          role: "assistant",
          text: e.text,
          ...(e.error ? { error: explainError(e.error, this.opts.dataDir) } : {}),
        });
        this.emit(live, {
          type: "agent.usage",
          modelCallId,
          messageId: reply.rowId,
          provider: e.provider,
          model: e.model,
          inputTokens: e.usage.input,
          outputTokens: e.usage.output,
          cacheReadTokens: e.usage.cacheRead,
          cacheWriteTokens: e.usage.cacheWrite,
          costMicros: cost,
          priced: priced !== undefined,
        });
        // Finished replies no longer need their buffer; the row has the text.
        live.replies.delete(e.key);
        return;
      }
      case "tool.start":
        live.stopStreak = 0;
        this.toolRow(live, e.toolCallId, e.tool, e.args);
        return;
      case "tool.denied":
        live.denied.set(e.toolCallId, e.reason);
        return;
      case "tool.end": {
        const id = live.tools.get(e.toolCallId);
        if (!id) return;
        const reason = live.denied.get(e.toolCallId);
        const end = {
          status:
            reason !== undefined
              ? ("denied" as const)
              : e.isError
                ? ("error" as const)
                : ("ok" as const),
          summary: reason ?? e.summary,
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        };
        this.store.finishToolCall(id, end);
        live.tools.delete(e.toolCallId);
        live.denied.delete(e.toolCallId);
        this.emit(live, { type: "agent.tool.end", toolCallId: id, ...end });
        return;
      }
      case "context": {
        const { type: _, ...fill } = e;
        this.emit(live, { type: "agent.context", ...fill });
        return;
      }
      case "run.settled":
        this.afterRun(live, e.aborted).catch(() => {
          live.currentReplyRow = undefined;
          live.tasks.endTurn();
          this.setBusy(live, false);
        });
        return;
    }
  }
}
