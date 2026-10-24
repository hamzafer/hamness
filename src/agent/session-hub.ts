import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ClaudeEnv, loadCompat } from "../compat/index.ts";
import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type {
  AgentEvent,
  ApprovalDecision,
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
  publish: (event: AgentEvent) => void;
  /** Load Claude Code's instructions, skills and MCP servers (ADR 0008). Default true. */
  contextFiles?: boolean;
  /** Where Claude Code's files are (`HOME`, `CLAUDE_CONFIG_DIR`). Default: the process env. */
  claude?: ClaudeEnv;
}

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

    const messageId = this.store.addMessage(this.ids(live), "user", text);
    this.emit(live, { type: "agent.message.start", messageId, role: "user" });
    this.emit(live, { type: "agent.message.end", messageId, role: "user", text });
    this.setBusy(live, true);
    live.runner.prompt(text).catch((err: unknown) => {
      const message = (err as Error).message ?? String(err);
      this.emit(live, { type: "agent.error", message: explainError(message, this.opts.dataDir) });
      this.setBusy(live, false);
    });
    return messageId;
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
    const withCompat = this.opts.contextFiles ?? true;
    const compat = withCompat
      ? loadCompat({
          cwd,
          dataDir: this.opts.dataDir,
          claude: this.opts.claude ?? { env: process.env },
        })
      : undefined;
    const runner = await startAgentRunner({
      cwd,
      agentDir: join(this.opts.dataDir, "pi"),
      sessionDir,
      ...(resume ? { resumeFile: resume.file } : {}),
      models,
      contextFiles: withCompat,
      ...(compat ? { compat } : {}),
      onEvent: (e) => live && this.onRunnerEvent(live, e),
      guard: async (call) => {
        if (!live) return { allow: false, reason: "session not ready" };
        const toolCallId = this.toolRow(live, call.toolCallId, call.tool, call.args);
        try {
          const target = live;
          const verdict = await this.safety(
            { sessionId: live.id, toolCallId, tool: call.tool, args: call.args, cwd: live.cwd },
            { cwd: live.cwd, askUser: (req) => this.requestApproval(target, req) },
          );
          return verdict;
        } catch (err) {
          return { allow: false, reason: `safety check failed: ${(err as Error).message}` };
        }
      },
    });
    const { sessionId, agentId } = resume
      ? { sessionId: resume.sessionId, agentId: resume.agentId }
      : this.store.createSession(cwd, model, runner.piSessionId);
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
    };
    this.byId.set(sessionId, live);
    return live;
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
    return {
      session: this.info(live),
      seq: live.seq,
      items,
      agents: this.store.agentTotals(live.id),
      ...(context ? { context } : {}),
      approvals: [...live.approvals.values()].map((e) => e.approval),
    };
  }

  private info(live: LiveSession): SessionInfo {
    const mode = this.opts.safetyMode?.(live.cwd);
    return {
      id: live.id,
      cwd: live.cwd,
      model: live.runner.model,
      busy: live.busy,
      mainAgentId: live.agentId,
      ...(mode ? { mode } : {}),
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

  private ids(live: LiveSession) {
    return { sessionId: live.id, agentId: live.agentId };
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
        live.currentReplyRow = undefined;
        this.setBusy(live, false);
        return;
    }
  }
}
