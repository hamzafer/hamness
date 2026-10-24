import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ContextFill } from "../events/types.ts";
import type { TokenUsage } from "../models/prices.ts";
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

export type ToolVerdict = { allow: true } | { allow: false; reason: string };

/**
 * The safety hook. Every tool call (built-in, custom and, later, MCP) passes through it
 * before it executes, via Pi's `tool_call` extension event. Ticket #4 puts rules and the
 * judge here; it may await a user's approval.
 */
export type ToolGuard = (call: ToolCallRequest) => Promise<ToolVerdict>;

export const allowAllTools: ToolGuard = async () => ({ allow: true });

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
  | { type: "run.settled"; aborted: boolean };

/**
 * A hamness tool the agent can call (the subagent tools, later `prove` and the task tools).
 * Its calls go through the guard like any other. Throwing makes the result an error.
 */
export interface RunnerTool {
  name: string;
  description: string;
  /** A TypeBox schema for the arguments. */
  parameters: TSchema;
  execute(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string>;
}

export interface RunnerOptions {
  cwd: string;
  /** Pi's config dir. Kept under hamness's data dir, never the user's `~/.pi`. */
  agentDir: string;
  models: ModelChoice;
  onEvent: (event: RunnerEvent) => void;
  guard?: ToolGuard;
  /** Load AGENTS.md / CLAUDE.md into the system prompt (Pi's loader). Default true. */
  contextFiles?: boolean;
  /** Where Pi writes its session JSONL. In memory when unset. */
  sessionDir?: string;
  /** A Pi session file to continue (its messages become the context). Needs `sessionDir`. */
  resumeFile?: string;
  /** hamness's own tools, added to Pi's built-in ones. */
  tools?: RunnerTool[];
}

export interface AgentRunner {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  readonly busy: boolean;
  /** `provider/id` of the model the next call uses. */
  readonly model: string;
  /** Pi's session id: the name of its JSONL file, used to resume after a restart. */
  readonly piSessionId: string;
  /** Switches the model for the next call. Throws when the provider has no credentials. */
  setModel(model: Model<Api>): Promise<void>;
  /** How full the context window is now (Pi's estimate), or undefined when Pi can't tell. */
  contextUsage(): ContextFill | undefined;
  /**
   * Puts a note in the context without starting a turn: during a run it lands after the
   * current turn, otherwise the next prompt's model call sees it.
   */
  notify(text: string): Promise<void>;
  dispose(): void;
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

export async function startAgentRunner(opts: RunnerOptions): Promise<AgentRunner> {
  const guard = opts.guard ?? allowAllTools;
  const emit = opts.onEvent;

  const safety: ExtensionFactory = (pi) => {
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
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    // Repo-local Pi extensions run code; hamness loads none until a trust model exists.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: opts.contextFiles === false,
    extensionFactories: [safety],
  });
  await resourceLoader.reload();

  const customTools: ToolDefinition[] = (opts.tools ?? []).map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      async execute(_id, params, signal) {
        const text = await t.execute(params as Record<string, unknown>, signal);
        return { content: [{ type: "text", text }], details: undefined };
      },
    }),
  );

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    modelRuntime: opts.models.runtime,
    model: opts.models.model,
    thinkingLevel: "medium",
    resourceLoader,
    ...(customTools.length ? { customTools } : {}),
    sessionManager: !opts.sessionDir
      ? SessionManager.inMemory(opts.cwd)
      : opts.resumeFile
        ? SessionManager.open(opts.resumeFile, opts.sessionDir)
        : SessionManager.create(opts.cwd, opts.sessionDir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    }),
  });

  const contextFill = (): ContextFill | undefined => {
    const u = session.getContextUsage();
    return u && { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent };
  };

  let busy = false;
  let model = opts.models.model;
  let seq = 0;
  let currentKey: string | undefined;
  const unsubscribe = session.subscribe((ev) => translate(ev));

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
    dispose() {
      unsubscribe();
      session.dispose();
    },
  };
}
