import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { estimateCostMicros } from "../models/prices.ts";
import {
  type HandlerContext,
  type Json,
  type LineHandler,
  num,
  projectName,
  Span,
  timestampOf,
} from "./handler.ts";

/*
 * Claude Code transcripts:
 *   <config>/projects/<project-key>/<sessionId>.jsonl                      main agent
 *   <config>/projects/<project-key>/<sessionId>/subagents/agent-<id>.jsonl  a subagent
 *   ...and agent-<id>.meta.json next to it (agentType, model).
 * One API response is split over several `assistant` lines with the same
 * `message.id`; the model_calls upsert keys on it, so each response counts once.
 */

const SOURCE = "claude-code";

export function claudeFileKind(path: string): "main" | "subagent" {
  return basename(dirname(path)) === "subagents" ? "subagent" : "main";
}

function readMeta(path: string): Json {
  try {
    return JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
}

export function claudeHandler({ store, path, state }: HandlerContext): LineHandler {
  const kind = claudeFileKind(path);
  const sessionExternal =
    kind === "main" ? basename(path, ".jsonl") : basename(dirname(dirname(path)));
  const sessionId = store.session(SOURCE, sessionExternal, "");
  const mainAgentId = store.agent(sessionId, "main", { kind: "main" });
  let agentId = mainAgentId;
  let metaModel: string | null = null;
  if (kind === "subagent") {
    const meta = readMeta(path);
    metaModel = typeof meta.model === "string" ? meta.model : null;
    agentId = store.agent(sessionId, basename(path, ".jsonl").replace(/^agent-/, ""), {
      kind: "subagent",
      name: typeof meta.agentType === "string" ? meta.agentType : null,
      parentAgentId: mainAgentId,
    });
  }
  state.sessionId = sessionId;
  state.agentId = agentId;

  const span = new Span();
  let agentModel: string | null = metaModel;
  let cwdSeen = false;

  return {
    line(obj) {
      const at = timestampOf(obj);
      span.see(at);
      if (!cwdSeen && typeof obj?.cwd === "string") {
        store.session(SOURCE, sessionExternal, projectName(obj.cwd));
        cwdSeen = true;
      }
      switch (obj?.type) {
        case "assistant":
          assistant(obj.message, obj.requestId, at);
          break;
        case "user":
          toolResults(obj.message?.content, at);
          break;
        case "system":
          if (obj.subtype === "turn_duration") span.activeMs += num(obj.durationMs);
          break;
      }
      return true;
    },
    finish() {
      store.touchSession(sessionId, {
        first: span.first,
        last: span.last,
        model: kind === "main" ? span.model : null,
        activeMs: span.activeMs,
      });
      store.touchAgent(agentId, { first: span.first, last: span.last, model: agentModel });
      state.activeMs = (state.activeMs ?? 0) + span.activeMs;
    },
  };

  function assistant(message: Json, requestId: unknown, at: number | null) {
    const model = message?.model;
    if (typeof model !== "string" || model === "<synthetic>") return;
    span.model = model;
    agentModel ??= model;
    const externalId = message.id ?? requestId;
    const u = message.usage;
    if (typeof externalId === "string" && u) {
      const usage = {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
      };
      store.modelCall({
        sessionId,
        agentId,
        externalId,
        provider: "anthropic",
        model,
        ...usage,
        costMicros: estimateCostMicros(model, usage),
        at,
      });
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          store.toolCall(sessionId, agentId, block.id, String(block.name ?? "unknown"), at);
        }
      }
    }
  }

  function toolResults(content: unknown, at: number | null) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        store.finishToolCall(sessionId, block.tool_use_id, block.is_error !== true, at);
      }
    }
  }
}
