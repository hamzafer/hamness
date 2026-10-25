import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  type CompatSetup,
  compatExtensions,
  compatPrompt,
  McpToolCounts,
} from "../compat/index.ts";
import type { CompactionReason, ContextFill, ThinkingLevel } from "../events/types.ts";
import type { TokenUsage } from "../models/prices.ts";
import { type Billing, billingLabel } from "./billing.ts";
import type { ModelChoice } from "./models.ts";

/**
 * The agent runner: one Pi agent loop (ADR 0002) behind a small interface.
 * Callers see hamness's own `RunnerEvent`s, never Pi's event types, so Pi can change underneath.
 */

/** A tool call about to run. `toolCallId` is Pi's id for it, the same one in `tool.start`. */
export interface ToolCallRequest {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A hamness tool the agent can call (task_start, prove, ...), in hamness's own terms; the
 * runner turns it into a Pi tool. It passes the same guard as every other tool. Throwing
 * gives the model an error result with the message.
 */
export interface AgentToolSpec {
  name: string;
  label: string;
  description: string;
  /** A TypeBox object schema. */
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; details?: Record<string, unknown> }>;
}

export type ToolVerdict = { allow: true } | { allow: false; reason: string };

/**
 * The safety hook. Every tool call (built-in, custom and, later, MCP) passes through it
 * before it executes, via Pi's `tool_call` extension event. Ticket #4 puts rules and the
 * judge here; it may await a user's approval.
 */
export type ToolGuard = (call: ToolCallRequest) => Promise<ToolVerdict>;

export const allowAllTools: ToolGuard = async () => ({ allow: true });

/**
 * Runs after a tool call finished (Claude Code's PostToolUse hooks). Text it returns is added
 * to the tool's result, so the model reads it next to the output.
 */
export type AfterTool = (
  call: ToolCallRequest & { output: string; isError: boolean },
) => Promise<string | undefined>;

export type RunnerEvent =
  | { type: "assistant.start"; key: string }
  | { type: "assistant.delta"; key: string; text: string }
  | {
      type: "assistant.end";
      key: string;
      text: string;
      provider: string;
      model: string;
      usage: TokenUsage;
      /** Pi's own catalog cost in USD, used when hamness's price table has no entry. */
      piCostUsd: number;
      durationMs?: number;
      stopReason: string;
      error?: string;
    }
  | {
      type: "tool.start";
      toolCallId: string;
      tool: string;
      args: Record<string, unknown>;
      /** The assistant message that asked for the call. */
      messageKey?: string;
    }
  | { type: "tool.denied"; toolCallId: string; reason: string }
  | {
      type: "tool.end";
      toolCallId: string;
      isError: boolean;
      summary: string;
      durationMs?: number;
    }
  /** After each turn (reply plus its tool results are in the session): how full the context is. */
  | ({ type: "context" } & ContextFill)
  | { type: "run.settled"; aborted: boolean }
  /** A user message went into Pi's session file as entry `entryId` (what `/fork` branches at). */
  | { type: "user.entry"; entryId: string }
  | { type: "thinking"; level: ThinkingLevel }
  | { type: "compaction.start"; reason: CompactionReason }
  | {
      type: "compaction.end";
      reason: CompactionReason;
      aborted: boolean;
      tokensBefore?: number;
      tokensAfter?: number;
      error?: string;
      /** The summary call's usage, when it made one. */
      usage?: TokenUsage;
      piCostUsd?: number;
      provider?: string;
      model?: string;
    };

/** Where a fork starts: Pi's session file and the entry its new branch ends at (null: empty). */
export interface BranchFrom {
  file: string;
  leafId: string | null;
}

/** What `compact` did, in Pi's estimates of the context size. */
export interface CompactionOutcome {
  tokensBefore: number;
  tokensAfter?: number;
  summary: string;
}

/** Pi's message counts for the session's file (`/session`). */
export interface RunnerStats {
  user: number;
  assistant: number;
  toolCalls: number;
}

export interface RunnerOptions {
  cwd: string;
  /** Pi's config dir. Kept under hamness's data dir, never the user's `~/.pi`. */
  agentDir: string;
  models: ModelChoice;
  onEvent: (event: RunnerEvent) => void;
  guard?: ToolGuard;
  afterTool?: AfterTool;
  /** Load instruction files into the system prompt. Default true. */
  contextFiles?: boolean;
  /**
   * Claude Code's instructions, skills and MCP servers for this cwd (`loadCompat`). Replaces Pi's
   * own context file lookup with Claude Code's, adds the `skill` tool and starts the MCP servers
   * marked to start. Without it, Pi's lookup applies and there are no skills or MCP servers.
   */
  compat?: CompatSetup;
  /** Where Pi writes its session JSONL. In memory when unset. */
  sessionDir?: string;
  /** A Pi session file to continue (its messages become the context). Needs `sessionDir`. */
  resumeFile?: string;
  /**
   * Start a new Pi session file holding `branchFrom.file`'s history up to `leafId` (Pi's fork).
   * Needs `sessionDir`; ignored with `resumeFile`.
   */
  branchFrom?: BranchFrom;
  /** The thinking level to start with. Default `medium` (Pi clamps it to what the model has). */
  thinkingLevel?: ThinkingLevel;
  /** hamness's own tools, next to Pi's built-ins. */
  tools?: AgentToolSpec[];
  /** Text added to the end of the system prompt. */
  systemPromptAppend?: string[];
}

export interface AgentRunner {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  readonly busy: boolean;
  /** `provider/id` of the model the next call uses. */
  readonly model: string;
  /** Pi's session id: the name of its JSONL file, used to resume after a restart. */
  readonly piSessionId: string;
  /** Pi's session file, when it keeps one on disk. */
  readonly sessionFile: string | undefined;
  /** Switches the model for the next call. Throws when the provider has no credentials. */
  setModel(model: Model<Api>): Promise<void>;
  /** How full the context window is now (Pi's estimate), or undefined when Pi can't tell. */
  contextUsage(): ContextFill | undefined;
  /**
   * Puts a note in the context without starting a turn: during a run it lands after the
   * current turn, otherwise the next prompt's model call sees it.
   */
  notify(text: string): Promise<void>;
  readonly thinkingLevel: ThinkingLevel;
  /** The levels the current model supports (Pi's list). */
  thinkingLevels(): ThinkingLevel[];
  /** Sets the level; Pi clamps it to the model's. Returns the level now in effect. */
  setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
  /** Pi's manual compaction (`/compact`). Throws Pi's reason when there is nothing to compact. */
  compact(instructions?: string): Promise<CompactionOutcome>;
  /** The name in Pi's session file (Pi's `/name`). */
  setName(name: string): void;
  stats(): RunnerStats;
  /** Pi's exports; each returns the path it wrote. */
  exportHtml(path: string): Promise<string>;
  exportJsonl(path: string): string;
  /** The text of the last assistant message in the context (Pi's `/copy`). */
  lastAssistantText(): string | undefined;
  /**
   * Where a fork at user message entry `entryId` starts: this file, up to the entry before it.
   * Undefined when the entry is not a user message of this session.
   */
  forkPoint(entryId: string): BranchFrom | undefined;
  /** Tools each started MCP server has registered so far (0 or absent: connecting or failed). */
  mcpTools(): Record<string, number>;
  /**
   * Ends the session: aborts its turn, shuts its extensions down (closing its MCP servers,
   * which kills their processes) and disposes it. Resolves once that is done; calling it
   * again returns the same promise.
   */
  dispose(): Promise<void>;
}

const SUMMARY_MAX = 200;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text")
    .map((b) => b.text)
    .join("");
}

function summarize(result: unknown): string {
  const text = textOf((result as { content?: unknown } | undefined)?.content).trim();
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function toPiTool(spec: AgentToolSpec): ToolDefinition {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    // Task tools change shared state (the open task); one at a time.
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const out = await spec.execute(toolCallId, (params ?? {}) as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: out.text }], details: out.details ?? {} };
    },
  };
}

/** Pi's session manager for a new, resumed or forked session (as Pi's own `/fork` builds it). */
function sessionManagerFor(opts: RunnerOptions): SessionManager {
  const dir = opts.sessionDir;
  if (!dir) return SessionManager.inMemory(opts.cwd);
  if (opts.resumeFile) return SessionManager.open(opts.resumeFile, dir);
  const branch = opts.branchFrom;
  if (!branch) return SessionManager.create(opts.cwd, dir);
  if (branch.leafId === null) {
    const fresh = SessionManager.create(opts.cwd, dir);
    fresh.newSession({ parentSession: branch.file });
    return fresh;
  }
  const source = SessionManager.open(branch.file, dir);
  if (!source.createBranchedSession(branch.leafId)) throw new Error("could not fork the session");
  return source;
}

function piUsage(u: AssistantMessage["usage"] | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}

/**
 * The system prompt's model line: what the agent runs on and how it is paid for, so it never
 * has to look in the environment. Rebuilt on every prompt, so it follows a model switch.
 */
export function modelPrompt(model: Model<Api>, billing: Billing | undefined): string {
  const name =
    model.name && model.name !== model.id
      ? `${model.name} (${model.provider}/${model.id})`
      : `${model.provider}/${model.id}`;
  const paid = billing ? ` Billing: ${billingLabel(billing, true)}.` : "";
  return `## Model (hamness)\nYou are running on ${name}.${paid} When asked which model you are, answer from this line; don't inspect the environment for it. hamness updates this line when the model changes.`;
}

export async function startAgentRunner(opts: RunnerOptions): Promise<AgentRunner> {
  const guard = opts.guard ?? allowAllTools;
  const emit = opts.onEvent;
  let model = opts.models.model;

  const safety: ExtensionFactory = (pi) => {
    // Each prompt carries the current model line; Pi sends the changed section as a patch.
    pi.on("before_agent_start", async (event) => {
      event.systemPromptOptions.appendSystemPrompt = promptAppend().join("\n\n");
      return undefined;
    });
    pi.on("tool_call", async (event) => {
      const verdict = await guard({
        toolCallId: event.toolCallId,
        tool: event.toolName,
        args: (event.input ?? {}) as Record<string, unknown>,
      });
      if (verdict.allow) return undefined;
      emit({ type: "tool.denied", toolCallId: event.toolCallId, reason: verdict.reason });
      return { block: true, reason: verdict.reason };
    });
    const after = opts.afterTool;
    if (after) {
      pi.on("tool_result", async (event) => {
        const extra = await after({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args: (event.input ?? {}) as Record<string, unknown>,
          output: textOf(event.content),
          isError: event.isError,
        });
        return extra ? { content: [...event.content, { type: "text", text: extra }] } : undefined;
      });
    }
  };

  const compat = opts.compat;
  const promptAppend = () => [
    ...(opts.systemPromptAppend ?? []),
    ...(compat ? compatPrompt(compat) : []),
    modelPrompt(model, opts.models.billing?.(model.provider)),
  ];
  const appendSystemPrompt = promptAppend();
  let sessionId: string | undefined;
  const mcpTools = new McpToolCounts();
  const compatFactories = compat
    ? compatExtensions(compat, {
        cwd: opts.cwd,
        agentDir: opts.agentDir,
        sessionId: () => sessionId,
        mcpTools,
      })
    : [];
  if (compat?.mcp.servers.some((s) => s.status === "start")) {
    // Pi's MCP client keeps OAuth tokens in its agent dir, found through this variable.
    process.env.PI_CODING_AGENT_DIR = opts.agentDir;
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    // Repo-local Pi extensions run code; hamness loads none until a trust model exists.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: opts.contextFiles === false,
    ...(compat
      ? {
          agentsFilesOverride: () => ({
            agentsFiles: compat.instructions.files.map((f) => ({
              path: f.path,
              content: f.content,
            })),
          }),
        }
      : {}),
    // Safety first, so its tool_call handler sees every tool the others add.
    extensionFactories: [safety, ...compatFactories],
    ...(appendSystemPrompt.length ? { appendSystemPrompt } : {}),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    modelRuntime: opts.models.runtime,
    model: opts.models.model,
    thinkingLevel: opts.thinkingLevel ?? "medium",
    resourceLoader,
    customTools: (opts.tools ?? []).map(toPiTool),
    sessionManager: sessionManagerFor(opts),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    }),
  });

  sessionId = session.sessionId;
  // Emits session_start: extensions start (the MCP servers connect in the background).
  await session.bindExtensions({});

  const contextFill = (): ContextFill | undefined => {
    const u = session.getContextUsage();
    return u && { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent };
  };

  let busy = false;
  let seq = 0;
  let currentKey: string | undefined;
  const unsubscribe = session.subscribe((ev) => translate(ev));
  let disposing: Promise<void> | undefined;

  function translate(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case "message_start":
        if (ev.message.role === "assistant") {
          currentKey = `a${++seq}`;
          emit({ type: "assistant.start", key: currentKey });
        }
        return;
      case "message_update":
        if (currentKey && ev.assistantMessageEvent.type === "text_delta") {
          emit({ type: "assistant.delta", key: currentKey, text: ev.assistantMessageEvent.delta });
        }
        return;
      case "message_end": {
        if (ev.message.role === "user") {
          // Pi appends the entry right after its listeners ran; read its id once it has.
          queueMicrotask(() => {
            const entry = session.sessionManager.getLeafEntry();
            if (entry?.type === "message" && entry.message.role === "user") {
              emit({ type: "user.entry", entryId: entry.id });
            }
          });
          return;
        }
        if (ev.message.role !== "assistant" || !currentKey) return;
        const m = ev.message as AssistantMessage & { durationMs?: number };
        emit({
          type: "assistant.end",
          key: currentKey,
          text: textOf(m.content),
          provider: m.provider,
          model: m.model,
          usage: {
            input: m.usage.input,
            output: m.usage.output,
            cacheRead: m.usage.cacheRead,
            cacheWrite: m.usage.cacheWrite,
            ...(m.usage.cacheWrite1h ? { cacheWrite1h: m.usage.cacheWrite1h } : {}),
          },
          piCostUsd: m.usage.cost.total,
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
          stopReason: m.stopReason,
          ...(m.errorMessage ? { error: m.errorMessage } : {}),
        });
        return;
      }
      case "tool_execution_start":
        emit({
          type: "tool.start",
          toolCallId: ev.toolCallId,
          tool: ev.toolName,
          args: (ev.args ?? {}) as Record<string, unknown>,
          ...(currentKey ? { messageKey: currentKey } : {}),
        });
        return;
      case "tool_execution_end":
        emit({
          type: "tool.end",
          toolCallId: ev.toolCallId,
          isError: ev.isError,
          summary: summarize(ev.result),
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        });
        return;
      case "turn_end": {
        // Pi stores the turn's messages only after listeners ran; read the fill once it has.
        queueMicrotask(() => {
          const fill = contextFill();
          if (fill) emit({ type: "context", ...fill });
        });
        return;
      }
      case "agent_settled":
        busy = false;
        emit({ type: "run.settled", aborted: ev.aborted });
        return;
      case "thinking_level_changed":
        emit({ type: "thinking", level: ev.level as ThinkingLevel });
        return;
      case "compaction_start":
        emit({ type: "compaction.start", reason: ev.reason });
        return;
      case "compaction_end": {
        const r = ev.result;
        const usage = piUsage(r?.usage as AssistantMessage["usage"] | undefined);
        const m = session.model;
        emit({
          type: "compaction.end",
          reason: ev.reason,
          aborted: ev.aborted,
          ...(r ? { tokensBefore: r.tokensBefore } : {}),
          ...(r?.estimatedTokensAfter !== undefined ? { tokensAfter: r.estimatedTokensAfter } : {}),
          ...(ev.errorMessage ? { error: ev.errorMessage } : {}),
          ...(usage && m
            ? {
                usage,
                piCostUsd: r?.usage?.cost?.total ?? 0,
                provider: m.provider,
                model: m.id,
              }
            : {}),
        });
        if (r) {
          const fill = contextFill();
          if (fill) emit({ type: "context", ...fill });
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    get busy() {
      return busy;
    },
    get model() {
      return `${model.provider}/${model.id}`;
    },
    get piSessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    async setModel(next) {
      await session.setModel(next);
      model = next;
    },
    async prompt(text) {
      busy = true;
      try {
        await session.prompt(text);
      } finally {
        busy = session.isStreaming;
      }
    },
    abort: () => session.abort(),
    contextUsage: contextFill,
    notify: (text) =>
      session.sendCustomMessage(
        { customType: "hamness.notice", content: text, display: true },
        { triggerTurn: false },
      ),
    get thinkingLevel() {
      return session.thinkingLevel as ThinkingLevel;
    },
    thinkingLevels: () => session.getAvailableThinkingLevels() as ThinkingLevel[],
    setThinkingLevel(level) {
      session.setThinkingLevel(level);
      return session.thinkingLevel as ThinkingLevel;
    },
    async compact(instructions) {
      const r = await session.compact(instructions);
      return {
        tokensBefore: r.tokensBefore,
        ...(r.estimatedTokensAfter !== undefined ? { tokensAfter: r.estimatedTokensAfter } : {}),
        summary: r.summary,
      };
    },
    setName: (name) => session.setSessionName(name),
    stats() {
      const s = session.getSessionStats();
      return { user: s.userMessages, assistant: s.assistantMessages, toolCalls: s.toolCalls };
    },
    exportHtml: (path) => session.exportToHtml(path),
    exportJsonl: (path) => session.exportToJsonl(path),
    lastAssistantText: () => session.getLastAssistantText(),
    mcpTools: () => mcpTools.counts(),
    forkPoint(entryId) {
      const entry = session.sessionManager.getEntry(entryId);
      const file = session.sessionFile;
      if (!file || entry?.type !== "message" || entry.message.role !== "user") return undefined;
      return { file, leafId: entry.parentId };
    },
    dispose() {
      if (disposing) return disposing;
      unsubscribe();
      // AgentSession.dispose() alone never emits session_shutdown, so Pi's MCP extension
      // never closed its servers: their stdio children outlived the session and kept the
      // daemon's process alive after SIGTERM. Shut the extensions down first, as Pi's own
      // session replacement does, then dispose.
      session.abort().catch(() => {});
      const ext = session.extensionRunner;
      const shutdown = ext.hasHandlers("session_shutdown")
        ? ext.emit({ type: "session_shutdown", reason: "quit" })
        : Promise.resolve();
      disposing = shutdown
        .catch(() => {})
        .then(() => {
          session.dispose();
        });
      return disposing;
    },
  };
}
