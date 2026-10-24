import type { Database } from "bun:sqlite";
import type { EvidenceKind, EvidenceStatus, TaskOutcome } from "../tasks/types.ts";
import type { DecisionSource } from "./queries.ts";
import { type Source, type StatsQuery, windowFor } from "./window.ts";

/**
 * Row-level lists for the dashboard: tasks, a task's evidence and safety decisions.
 * Lists are newest first and page with an opaque cursor (`nextCursor`, null on the last page).
 */

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 500;

export class CursorError extends Error {
  constructor() {
    super("cursor is not one this server gave out");
    this.name = "CursorError";
  }
}

/** A cursor is the last row's time and id: `<ms>.<id>`. */
const encodeCursor = (at: number, id: string) => `${at}.${id}`;

function decodeCursor(cursor: string | undefined): [number, string] | null {
  if (cursor === undefined) return null;
  const m = /^(\d{1,16})\.([\w-]{1,64})$/.exec(cursor);
  if (!m?.[1] || !m[2]) throw new CursorError();
  return [Number(m[1]), m[2]];
}

const pageSize = (limit: number | undefined) =>
  Math.max(1, Math.min(Math.trunc(limit ?? DEFAULT_PAGE), MAX_PAGE));

function paged<T extends { id: string }>(rows: T[], limit: number, at: (r: T) => number): Page<T> {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return { rows: page, nextCursor: more && last ? encodeCursor(at(last), last.id) : null };
}

// ---- Tasks ----

export interface TaskListQuery extends StatsQuery {
  outcome?: TaskOutcome | undefined;
  /** False leaves out turn tasks (the implicit per-turn ones). Default true. */
  turns?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface TaskListRow {
  id: string;
  sessionId: string;
  source: Source;
  goal: string;
  /** A turn task: hamness opened it for one turn with no task open. */
  implicit: boolean;
  outcome: TaskOutcome;
  /** The user's reason for an override or abandon. */
  reason: string | null;
  summary: string | null;
  /** Sums over the task's model calls. */
  costMicros: number;
  tokens: number;
  startedAt: number;
  endedAt: number | null;
  /** Wall time, start to end (to the range's end while open). */
  durationMs: number;
  /** Checked evidence, how many of it passed, and claims not checked yet. */
  evidence: { checked: number; passed: number; pending: number };
}

interface TaskSqlRow {
  id: string;
  sessionId: string;
  source: Source;
  goal: string;
  implicit: number;
  outcome: TaskOutcome;
  reason: string | null;
  summary: string | null;
  at: number;
  endedAt: number | null;
  cost: number;
  tokens: number;
  checked: number;
  passed: number;
  pending: number;
}

/** Tasks that started in the range, newest first. Dropped turn tasks are gone from the table. */
export function listTasks(sqlite: Database, q: TaskListQuery): Page<TaskListRow> {
  const w = windowFor(q);
  const limit = pageSize(q.limit);
  const after = decodeCursor(q.cursor);
  const rows = sqlite
    .query<
      TaskSqlRow,
      [number, number, string | null, string | null, number, number | null, string | null, number]
    >(
      `SELECT t.id, t.session_id AS sessionId, s.source, t.goal, t.implicit, t.outcome,
         t.outcome_reason AS reason, t.summary, coalesce(t.started_at, t.created_at) AS at,
         t.ended_at AS endedAt,
         coalesce(mc.cost, 0) AS cost, coalesce(mc.tokens, 0) AS tokens,
         coalesce(ev.checked, 0) AS checked, coalesce(ev.passed, 0) AS passed,
         coalesce(ev.pending, 0) AS pending
       FROM tasks t JOIN sessions s ON s.id = t.session_id
       LEFT JOIN (
         SELECT task_id, sum(cost_micros) AS cost,
           sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
         FROM model_calls WHERE task_id IS NOT NULL GROUP BY task_id
       ) mc ON mc.task_id = t.id
       LEFT JOIN (
         SELECT task_id, sum(status != 'pending') AS checked, sum(status = 'passed') AS passed,
           sum(status = 'pending') AS pending
         FROM evidence GROUP BY task_id
       ) ev ON ev.task_id = t.id
       WHERE coalesce(t.started_at, t.created_at) BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR s.source = ?3)
         AND (?4 IS NULL OR t.outcome = ?4)
         AND (?5 = 1 OR t.implicit = 0)
         AND (?6 IS NULL OR coalesce(t.started_at, t.created_at) < ?6
              OR (coalesce(t.started_at, t.created_at) = ?6 AND t.id < ?7))
       ORDER BY at DESC, t.id DESC
       LIMIT ?8`,
    )
    .all(
      w.from,
      w.to,
      w.source,
      q.outcome ?? null,
      q.turns === false ? 0 : 1,
      after?.[0] ?? null,
      after?.[1] ?? null,
      limit + 1,
    );
  return paged(
    rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      source: r.source,
      goal: r.goal,
      implicit: r.implicit === 1,
      outcome: r.outcome,
      reason: r.reason,
      summary: r.summary,
      costMicros: r.cost,
      tokens: r.tokens,
      startedAt: r.at,
      endedAt: r.endedAt,
      durationMs: Math.max(0, (r.endedAt ?? w.to) - r.at),
      evidence: { checked: r.checked, passed: r.passed, pending: r.pending },
    })),
    limit,
    (r) => r.startedAt,
  );
}

// ---- Evidence ----

export interface EvidenceRow {
  id: string;
  kind: EvidenceKind;
  /** What was claimed, in one line: the command, path, URL or PR. */
  claim: string;
  status: EvidenceStatus;
  /** The checker's one-line finding. Null while pending. */
  summary: string | null;
  createdAt: number;
  checkedAt: number | null;
}

function claimLine(kind: EvidenceKind, json: string): string {
  let c: Record<string, unknown> = {};
  try {
    c = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return kind;
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof c[k] === "string" && c[k]) return c[k] as string;
    return kind;
  };
  if (kind === "command") return pick("command");
  if (kind === "file") return pick("path");
  if (kind === "url") return pick("url");
  return pick("pr", "commit", "repo");
}

function resultSummary(json: string | null): string | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as { summary?: unknown };
    return typeof r.summary === "string" ? r.summary : null;
  } catch {
    return null;
  }
}

/** A task's evidence in the order it was submitted. Only the summary of each result, no output. */
export function taskEvidence(sqlite: Database, taskId: string): EvidenceRow[] {
  return sqlite
    .query<
      {
        id: string;
        kind: EvidenceKind;
        claim_json: string;
        status: EvidenceStatus;
        result_json: string | null;
        created_at: number;
        checked_at: number | null;
      },
      [string]
    >(
      `SELECT id, kind, claim_json, status, result_json, created_at, checked_at
       FROM evidence WHERE task_id = ? ORDER BY created_at, id`,
    )
    .all(taskId)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      claim: claimLine(r.kind, r.claim_json),
      status: r.status,
      summary: resultSummary(r.result_json),
      createdAt: r.created_at,
      checkedAt: r.checked_at,
    }));
}

// ---- Decisions ----

export type Verdict = "allow" | "ask" | "deny";

export interface DecisionListQuery extends StatsQuery {
  verdict?: Verdict | undefined;
  decidedBy?: DecisionSource | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface DecisionListRow {
  id: string;
  sessionId: string | null;
  /** The source of the decision's session; null for a decision outside any session. */
  sessionSource: Source | null;
  tool: string;
  verdict: Verdict;
  decidedBy: DecisionSource;
  reason: string | null;
  rule: string | null;
  latencyMs: number | null;
  costMicros: number;
  createdAt: number;
}

/**
 * Safety decisions in the range, newest first. No tool arguments: the audit log has them
 * (`hamness audit`). Decisions without a session show only when no source filter is set.
 */
export function listDecisions(sqlite: Database, q: DecisionListQuery): Page<DecisionListRow> {
  const w = windowFor(q);
  const limit = pageSize(q.limit);
  const after = decodeCursor(q.cursor);
  const rows = sqlite
    .query<
      DecisionListRow,
      [
        number,
        number,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        number,
      ]
    >(
      `SELECT d.id, d.session_id AS sessionId, s.source AS sessionSource, d.tool, d.verdict,
         d.source AS decidedBy, d.reason, d.rule, d.latency_ms AS latencyMs,
         d.cost_micros AS costMicros, d.created_at AS createdAt
       FROM decisions d LEFT JOIN sessions s ON s.id = d.session_id
       WHERE d.created_at BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
         AND (?4 IS NULL OR d.verdict = ?4) AND (?5 IS NULL OR d.source = ?5)
         AND (?6 IS NULL OR d.created_at < ?6 OR (d.created_at = ?6 AND d.id < ?7))
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?8`,
    )
    .all(
      w.from,
      w.to,
      w.source,
      q.verdict ?? null,
      q.decidedBy ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      limit + 1,
    );
  return paged(rows, limit, (r) => r.createdAt);
}
