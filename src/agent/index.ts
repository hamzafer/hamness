/**
 * Agent loop: Pi used as a library (ADR 0002).
 *
 * - `runner.ts`: one Pi agent loop behind `AgentRunner`, with the tool guard hook.
 * - `session-hub.ts`: live sessions per cwd; runner events become rows and published events.
 *   It also runs subagents (ADR 0015): `subagent-tools.ts` has their tools, `worktrees.ts` their
 *   git worktrees.
 * - `store.ts`: the chat rows (sessions, agents, messages, tool_calls, model_calls).
 * - `models.ts`: model resolution and the model list. Prices live in `src/models/price-data.ts`.
 * - `keys.ts`: the 0600 key file; `login.ts`: provider sign-in through Pi (no Claude subscriptions).
 */
export { type AgentRunner, type RunnerEvent, startAgentRunner, type ToolGuard } from "./runner.ts";
export { SessionHub } from "./session-hub.ts";
