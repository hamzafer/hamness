import type { SafetyCheck } from "../../safety/index.ts";

/** How a checker runs `gh`. Injectable so tests never reach the network. */
export type GhRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** What every checker gets: where the task runs, when it started, and the outside world. */
export interface CheckContext {
  sessionId: string;
  cwd: string;
  /** The `tool_calls` row of the `prove` call, for the safety check of a command re-run. */
  toolCallId: string;
  /** Task start (ms): a file must be written at or after it. */
  taskStartedAt: number;
  safety: SafetyCheck;
  gh: GhRunner;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Aborts a running check (the user pressed Esc). */
  signal?: AbortSignal;
}
