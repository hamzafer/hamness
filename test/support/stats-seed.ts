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

  const task = (o: { sessionId: string; at: number; outcome: Outcome }) => {
    const id = newId();
    sqlite
      .query(
        `INSERT INTO tasks (id, session_id, goal, outcome, started_at, created_at, updated_at)
         VALUES (?, ?, 'a goal', ?, ?, ?, ?)`,
      )
      .run(id, o.sessionId, o.outcome, o.at, o.at, o.at);
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
  }) => {
    sqlite
      .query(
        `INSERT INTO model_calls (id, session_id, task_id, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_micros, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'p', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  }) => {
    sqlite
      .query(
        `INSERT INTO decisions (id, session_id, tool, verdict, source, latency_ms, cost_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        o.sessionId ?? null,
        o.tool ?? "bash",
        o.verdict,
        o.source,
        o.latencyMs ?? null,
        o.costMicros ?? 0,
        o.at,
        o.at,
      );
  };

  return { session, task, modelCall, toolCall, decision };
}
