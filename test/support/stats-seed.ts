import type { Database } from "bun:sqlite";
import { newId } from "../../src/db/ids.ts";

/** Builders for synthetic stats fixtures. Every row is made up; no real history. */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

type Source = "hamness" | "claude-code" | "codex";
type Outcome = "open" | "verified" | "unverified" | "overridden" | "abandoned";

export function seeder(sqlite: Database) {
  const session = (o: {
    source: Source;
    at: number;
    endAt?: number | null;
    activeMs?: number | null;
    cwd?: string;
  }) => {
    const id = newId();
    sqlite
      .query(
        `INSERT INTO sessions (id, source, cwd, started_at, ended_at, active_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, o.source, o.cwd ?? "app", o.at, o.endAt ?? null, o.activeMs ?? null, o.at, o.at);
    return id;
  };

  const task = (o: {
    sessionId: string;
    at: number;
    outcome: Outcome;
    goal?: string;
    implicit?: boolean;
    endAt?: number | null;
    reason?: string | null;
    branch?: string;
    commitSha?: string;
    prUrl?: string;
  }) => {
    const id = newId();
    sqlite
      .query(
        `INSERT INTO tasks (id, session_id, goal, implicit, outcome, outcome_reason, started_at,
           ended_at, branch, commit_sha, pr_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.sessionId,
        o.goal ?? "a goal",
        o.implicit ? 1 : 0,
        o.outcome,
        o.reason ?? null,
        o.at,
        o.endAt ?? null,
        o.branch ?? null,
        o.commitSha ?? null,
        o.prUrl ?? null,
        o.at,
        o.at,
      );
    return id;
  };

  /** A claim, then (unless pending) the checker's result, the way proof.ts writes it. */
  const evidence = (o: {
    taskId: string;
    at: number;
    kind?: "command" | "file" | "url" | "ci";
    claim?: Record<string, unknown>;
    status: "pending" | "passed" | "failed" | "error";
    summary?: string;
  }) => {
    const id = newId();
    const kind = o.kind ?? "command";
    const claim = o.claim ?? { kind, command: "bun test" };
    sqlite
      .query(
        `INSERT INTO evidence (id, task_id, kind, claim_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, o.taskId, kind, JSON.stringify(claim), o.at, o.at);
    if (o.status !== "pending")
      sqlite
        .query("UPDATE evidence SET status = ?, result_json = ?, checked_at = ? WHERE id = ?")
        .run(o.status, JSON.stringify({ summary: o.summary ?? o.status, exitCode: 0 }), o.at, id);
    return id;
  };

  const modelCall = (o: {
    sessionId: string;
    at: number;
    model: string;
    taskId?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costMicros?: number;
    billing?: "plan";
  }) => {
    sqlite
      .query(
        `INSERT INTO model_calls (id, session_id, task_id, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_micros, started_at, created_at, updated_at, billing)
         VALUES (?, ?, ?, 'p', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        o.sessionId,
        o.taskId ?? null,
        o.model,
        o.input ?? 0,
        o.output ?? 0,
        o.cacheRead ?? 0,
        o.cacheWrite ?? 0,
        o.costMicros ?? 0,
        o.at,
        o.at,
        o.at,
        o.billing ?? null,
      );
  };

  const toolCall = (o: {
    sessionId: string;
    at: number;
    tool: string;
    status?: "ok" | "error" | "denied" | "pending";
    durationMs?: number | null;
  }) => {
    const id = newId();
    sqlite
      .query(
        `INSERT INTO tool_calls (id, session_id, tool, status, duration_ms, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, o.sessionId, o.tool, o.status ?? "ok", o.durationMs ?? null, o.at, o.at, o.at);
    return id;
  };

  const decision = (o: {
    sessionId?: string | null;
    at: number;
    tool?: string;
    verdict: "allow" | "ask" | "deny";
    source: "rule" | "judge" | "hook" | "user" | "mode";
    latencyMs?: number | null;
    costMicros?: number;
    reason?: string | null;
    rule?: string | null;
    /** The tool call's (already redacted) arguments. */
    args?: Record<string, unknown>;
  }) => {
    const id = newId();
    sqlite
      .query(
        `INSERT INTO decisions (id, session_id, tool, args_json, verdict, source, reason, rule,
           latency_ms, cost_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.sessionId ?? null,
        o.tool ?? "bash",
        o.args ? JSON.stringify(o.args) : null,
        o.verdict,
        o.source,
        o.reason ?? null,
        o.rule ?? null,
        o.latencyMs ?? null,
        o.costMicros ?? 0,
        o.at,
        o.at,
      );
    return id;
  };

  return { session, task, evidence, modelCall, toolCall, decision };
}
