import { join } from "node:path";
import type { HamnessDb } from "../db/open.ts";
import type { AgentEvent, SessionInfo, SessionSnapshot, TranscriptItem } from "../events/types.ts";
import { costMicros } from "../models/prices.ts";
import { allowAll, redactArgs, type SafetyCheck } from "../safety/index.ts";
import { keyFilePath, type ModelChoice } from "./models.ts";
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
  publish: (event: AgentEvent) => void;
  contextFiles?: boolean;
}

/** Pi's "No API key" error points at its own `/login`; say what works in hamness instead. */
function explainError(message: string, dataDir: string): string {
  const missing = /No API key found for ([\w-]+)/.exec(message);
  if (!missing) return message;
  const provider = missing[1] ?? "anthropic";
  const envVar = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return `No API key for ${provider}. Set ${envVar}, or put {"${provider}": "<key>"} in ${keyFilePath(dataDir)} (mode 0600), then restart the daemon.`;
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
  seq: number;
  busy: boolean;
  /** Assistant message rows by the runner's key, with their text so far. */
  replies: Map<string, { rowId: string; text: string; done: boolean }>;
  /** The latest assistant message row; tool calls after it belong to it. */
  currentReplyRow: string | undefined;
  /** `tool_calls` row ids by Pi's tool call id. */
  tools: Map<string, string>;
  denied: Map<string, string>;
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

  async abort(sessionId: string): Promise<boolean> {
    const live = this.byId.get(sessionId);
    if (!live) return false;
    await live.runner.abort();
    return true;
  }

  stop(): void {
    for (const live of this.byId.values()) live.runner.dispose();
    this.byId.clear();
    this.byCwd.clear();
  }

  private async create(cwd: string): Promise<LiveSession> {
    const models = await this.opts.models();
    const model = `${models.model.provider}/${models.model.id}`;
    // `live` is filled in before the runner can emit anything: events only follow a prompt.
    let live: LiveSession | undefined;
    const runner = await startAgentRunner({
      cwd,
      agentDir: join(this.opts.dataDir, "pi"),
      sessionDir: join(this.opts.dataDir, "pi", "sessions"),
      models,
      contextFiles: this.opts.contextFiles ?? true,
      onEvent: (e) => live && this.onRunnerEvent(live, e),
      guard: async (call) => {
        if (!live) return { allow: false, reason: "session not ready" };
        const toolCallId = this.toolRow(live, call.toolCallId, call.tool, call.args);
        try {
          const verdict = await this.safety({
            sessionId: live.id,
            toolCallId,
            tool: call.tool,
            args: call.args,
          });
          return verdict;
        } catch (err) {
          return { allow: false, reason: `safety check failed: ${(err as Error).message}` };
        }
      },
    });
    const { sessionId, agentId } = this.store.createSession(cwd, model);
    live = {
      id: sessionId,
      agentId,
      cwd,
      runner,
      seq: 0,
      busy: false,
      replies: new Map(),
      currentReplyRow: undefined,
      tools: new Map(),
      denied: new Map(),
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
    };
  }

  private info(live: LiveSession): SessionInfo {
    return {
      id: live.id,
      cwd: live.cwd,
      model: live.runner.model,
      busy: live.busy,
      mainAgentId: live.agentId,
    };
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
