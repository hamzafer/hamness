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
 * Codex rollouts: <codex>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
 * (older days as .jsonl.zst) and <codex>/archived_sessions/. Every line is
 * {timestamp, type, payload}; the first is `session_meta`. A thread with
 * `parent_thread_id` is a subagent of its parent's session.
 *
 * Tokens: each `token_count` event carries this call's usage (`last_token_usage`)
 * and the thread's running total. Codex repeats identical events, so the call is
 * keyed by the running total. OpenAI's `input_tokens` includes cached tokens; we
 * store uncached input in `input_tokens` and cached in `cache_read_tokens`, the
 * same split as Claude.
 *
 * Files from before `session_meta` existed (2025) carry no token counts and are
 * skipped.
 */

const SOURCE = "codex";

export function codexHandler({ store, state }: HandlerContext): LineHandler {
  const span = new Span();
  let agentModel: string | null = null;

  return {
    line(obj) {
      const at = timestampOf(obj);
      const p = obj?.payload;
      if (!state.sessionId && obj?.type !== "session_meta") {
        state.skipped = true;
        return false;
      }
      span.see(at);
      switch (obj?.type) {
        case "session_meta":
          meta(p);
          break;
        case "turn_context":
          if (typeof p?.model === "string") {
            state.model = p.model;
            span.model = p.model;
            agentModel ??= p.model;
          }
          break;
        case "event_msg":
          if (p?.type === "token_count") tokens(p.info, at);
          else if (p?.type === "task_complete") span.activeMs += num(p.duration_ms);
          break;
        case "response_item":
          item(p, at);
          break;
      }
      return true;
    },
    finish() {
      if (!state.sessionId || !state.agentId) return;
      store.touchSession(state.sessionId, {
        first: span.first,
        last: span.last,
        model: state.subagent ? null : span.model,
        activeMs: span.activeMs,
      });
      store.touchAgent(state.agentId, { first: span.first, last: span.last, model: agentModel });
      state.activeMs = (state.activeMs ?? 0) + span.activeMs;
    },
  };

  function meta(p: Json) {
    if (typeof p?.id !== "string") return;
    const project = projectName(p.cwd);
    const parent = typeof p.parent_thread_id === "string" ? p.parent_thread_id : null;
    const sessionId = store.session(SOURCE, parent ?? p.id, project);
    const mainAgentId = store.agent(sessionId, "main", { kind: "main" });
    state.sessionId = sessionId;
    state.agentId = parent
      ? store.agent(sessionId, p.id, { kind: "subagent", parentAgentId: mainAgentId })
      : mainAgentId;
    state.provider = typeof p.model_provider === "string" ? p.model_provider : "openai";
    state.subagent = parent !== null;
  }

  function tokens(info: Json, at: number | null) {
    const last = info?.last_token_usage;
    const total = info?.total_token_usage;
    if (!last || !total || !state.sessionId || !state.agentId) return;
    const cached = num(last.cached_input_tokens);
    const usage = {
      input: Math.max(0, num(last.input_tokens) - cached),
      output: num(last.output_tokens),
      cacheRead: cached,
      cacheWrite: num(last.cache_write_input_tokens),
    };
    const model = state.model ?? "unknown";
    store.modelCall({
      sessionId: state.sessionId,
      agentId: state.agentId,
      externalId: `${state.agentId}:${num(total.total_tokens)}`,
      provider: state.provider ?? "openai",
      model,
      ...usage,
      costMicros: estimateCostMicros(model, usage),
      at,
    });
  }

  function item(p: Json, at: number | null) {
    if (!state.sessionId || !state.agentId || typeof p?.call_id !== "string") return;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      store.toolCall(state.sessionId, state.agentId, p.call_id, String(p.name ?? "unknown"), at);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      store.finishToolCall(state.sessionId, p.call_id, true, at);
    }
  }
}
