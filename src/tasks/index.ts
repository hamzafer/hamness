/**
 * Tasks and the proof gate (ADRs 0004, 0005, 0012): the per-session task state and outcome
 * rules (`SessionTasks`), the agent's tools (`task_start`, `prove`, `task_done`) and the
 * checkers that alone write evidence results (`proof.ts`, enforced again by migration 0006).
 */

export type { CheckContext, GhRunner } from "./checkers/index.ts";
export { runGh } from "./checkers/index.ts";
export { PROVE_PARAMETERS, parseClaim } from "./claims.ts";
export { SessionTasks, TaskStateError } from "./session-tasks.ts";
export { PROOF_GATE_PROMPT, taskTools } from "./tools.ts";
export type * from "./types.ts";
