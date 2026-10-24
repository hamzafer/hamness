/** Tasks and evidence, as hamness code and clients see them (ADRs 0004, 0005, 0012). */

export type TaskOutcome = "open" | "verified" | "unverified" | "overridden" | "abandoned";

export type EvidenceKind = "command" | "file" | "url" | "ci";

/** `passed` / `failed`: the checker decided. `error`: it could not check (blocked, gh missing...). */
export type EvidenceStatus = "pending" | "passed" | "failed" | "error";

/**
 * What an agent submits with `prove`. Claims carry no result field of any kind: a result is
 * only ever what a checker found.
 */
export type EvidenceClaim =
  | { kind: "command"; command: string; timeoutSeconds?: number }
  | { kind: "file"; path: string }
  | { kind: "url"; url: string; timeoutSeconds?: number }
  | { kind: "ci"; pr?: string; commit?: string; repo?: string };

/** What a checker found. `summary` is one line for the agent, the transcript and the rail. */
export interface CheckResult {
  status: Exclude<EvidenceStatus, "pending">;
  summary: string;
  /** Stored as `evidence.result_json`; secrets already redacted. */
  details: Record<string, unknown>;
}

/** One task with its roll-up, as the API, events and rail carry it. */
export interface TaskView {
  id: string;
  goal: string;
  /** True for the per-turn task hamness opens when no task is open. */
  implicit: boolean;
  outcome: TaskOutcome;
  summary?: string;
  /** The user's reason for an override or abandon. */
  reason?: string;
  /** Evidence checked so far, and how many passed. */
  evidence: number;
  passed: number;
  /** Sums over the task's model calls. */
  costMicros: number;
  tokens: number;
  startedAt: number;
  endedAt?: number;
  /** Wall time, start to end (or to now while open). */
  durationMs: number;
}

/** A user action on the session's task, from the TUI's slash commands. */
export type TaskAction =
  | { kind: "start"; goal: string }
  | { kind: "override"; reason?: string }
  | { kind: "abandon"; reason?: string };
