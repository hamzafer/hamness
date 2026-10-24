import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Synthetic Claude Code and Codex history. Shapes follow the on-disk formats
 * (keys only); every value here is made up.
 */

type Json = Record<string, unknown>;

export const jsonl = (lines: Json[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

export function writeLines(path: string, lines: Json[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonl(lines));
  return path;
}

export function appendLines(path: string, lines: Json[]): void {
  appendFileSync(path, jsonl(lines));
}

// ---- Claude Code ----

export const CWD = "/work/demo-app";

export function claudeSessionPath(configDir: string, sessionId: string): string {
  return join(configDir, "projects", "-work-demo-app", `${sessionId}.jsonl`);
}

export function claudeSubagentPath(configDir: string, sessionId: string, agentId: string): string {
  return join(
    configDir,
    "projects",
    "-work-demo-app",
    sessionId,
    "subagents",
    `agent-${agentId}.jsonl`,
  );
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const base = (sessionId: string, ts: string) => ({
  sessionId,
  timestamp: ts,
  cwd: CWD,
  gitBranch: "main",
  version: "9.9.9",
  uuid: crypto.randomUUID(),
});

export function claudeUser(sessionId: string, ts: string, text = "do the thing"): Json {
  return { ...base(sessionId, ts), type: "user", message: { role: "user", content: text } };
}

export function claudeAssistant(
  sessionId: string,
  ts: string,
  opts: {
    id: string;
    model?: string;
    usage?: Usage;
    content?: Json[];
  },
): Json {
  const u = opts.usage ?? {};
  return {
    ...base(sessionId, ts),
    type: "assistant",
    requestId: `req_${opts.id}`,
    message: {
      id: opts.id,
      role: "assistant",
      model: opts.model ?? "claude-sonnet-4-5",
      content: opts.content ?? [{ type: "text", text: "hushword assistant words" }],
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation_input_tokens: u.cacheWrite ?? 0,
      },
    },
  };
}

export const toolUse = (id: string, name: string): Json => ({
  type: "tool_use",
  id,
  name,
  input: { command: "echo hushword-arg" },
});

export function claudeToolResult(
  sessionId: string,
  ts: string,
  toolUseId: string,
  isError = false,
): Json {
  return {
    ...base(sessionId, ts),
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "hushword output",
          is_error: isError,
        },
      ],
    },
  };
}

export function claudeTurnDuration(sessionId: string, ts: string, durationMs: number): Json {
  return { ...base(sessionId, ts), type: "system", subtype: "turn_duration", durationMs };
}

// ---- Codex ----

export const CODEX_CWD = "/work/codex-app";

export function codexSessionPath(codexDir: string, threadId: string, day = "2026/03/04"): string {
  return join(codexDir, "sessions", day, `rollout-2026-03-04T10-00-00-${threadId}.jsonl`);
}

export function codexMeta(threadId: string, ts: string, extra: Json = {}): Json {
  return {
    timestamp: ts,
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp: ts,
      cwd: CODEX_CWD,
      cli_version: "9.9.9",
      originator: "codex_cli",
      model_provider: "openai",
      instructions: "hushword instructions",
      ...extra,
    },
  };
}

export function codexTurnContext(ts: string, model: string): Json {
  return { timestamp: ts, type: "turn_context", payload: { model, cwd: CODEX_CWD, turn_id: "t1" } };
}

interface CodexUsage {
  input: number;
  cached?: number;
  output: number;
}

const codexUsage = (u: CodexUsage) => ({
  input_tokens: u.input,
  cached_input_tokens: u.cached ?? 0,
  output_tokens: u.output,
  reasoning_output_tokens: 0,
  total_tokens: u.input + u.output,
});

/** A token_count event: `last` is this call, `total` the thread's running sum. */
export function codexTokenCount(ts: string, last: CodexUsage, total: CodexUsage): Json {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: codexUsage(last), total_token_usage: codexUsage(total) },
    },
  };
}

export function codexFunctionCall(ts: string, callId: string, name: string): Json {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call", name, arguments: '{"cmd":"hushword"}', call_id: callId },
  };
}

export function codexFunctionOutput(ts: string, callId: string): Json {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output: "hushword output" },
  };
}

export function codexTaskComplete(ts: string, durationMs: number): Json {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t1", duration_ms: durationMs },
  };
}

export function codexMessage(ts: string, text = "hushword user words"): Json {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
