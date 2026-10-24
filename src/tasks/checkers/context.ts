import type { GuardedCall, SafetyVerdict } from "../../safety/index.ts";

/** How a checker runs `gh`. Injectable so tests never reach the network. */
export type GhRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** How a checker runs `git` in the session folder. Injectable like `gh`. */
export type GitRunner = (
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
  /** Whether the agent wrote this (real, absolute) path with its own write / edit tools in the task. */
  writtenByAgent?: (path: string) => boolean;
  /** Every path (absolute, and real) the agent wrote with its own write / edit tools in the task. */
  writtenPaths?: () => Set<string>;
  /** The session's safety check, bound to its approval prompt. Throwing counts as a deny. */
  safety: (call: GuardedCall) => Promise<SafetyVerdict>;
  gh: GhRunner;
  git: GitRunner;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The user config's `proof.allowPrivateUrls`: `prove url` may reach loopback / private hosts. */
  allowPrivateUrls?: boolean;
  /** Resolves a host name to its addresses. Default: the system resolver. Tests pass a fake. */
  lookup?: (host: string) => Promise<string[]>;
  /** Aborts a running check (the user pressed Esc). */
  signal?: AbortSignal;
}
