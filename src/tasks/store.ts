import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { EvidenceClaim, TaskOutcome, TaskView } from "./types.ts";

interface TaskRow {
  id: string;
  goal: string;
  implicit: number;
  outcome: TaskOutcome;
  summary: string | null;
  outcome_reason: string | null;
  started_at: number;
  ended_at: number | null;
}

/** Tools whose calls change files: a turn that used them did work worth proving. */
const MUTATING_TOOLS = ["edit", "write"];

/**
 * The `tasks` rows and evidence claims. It has no way to write an evidence result:
 * that is `proof.ts`'s job alone (and the database refuses anything else, migration 0006).
 */
export class TaskStore {
  constructor(private readonly db: HamnessDb) {}

  private get sql() {
    return this.db.sqlite;
  }

  open(sessionId: string, goal: string, implicit: boolean): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO tasks (id, session_id, goal, implicit, outcome, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(id, sessionId, goal, implicit ? 1 : 0, now, now, now);
    return id;
  }

  /** An implicit task becomes an explicit one with the agent's or user's goal. */
  promote(id: string, goal: string): void {
    this.sql.query("UPDATE tasks SET goal = ?, implicit = 0 WHERE id = ?").run(goal, id);
  }

  close(
    id: string,
    outcome: Exclude<TaskOutcome, "open">,
    opts: { summary?: string; reason?: string } = {},
  ): void {
    const now = Date.now();
    this.sql
      .query(
        `UPDATE tasks SET outcome = ?, summary = COALESCE(?, summary),
           outcome_reason = COALESCE(?, outcome_reason), ended_at = COALESCE(ended_at, ?)
         WHERE id = ?`,
      )
      .run(outcome, opts.summary ?? null, opts.reason ?? null, now, id);
  }

  /**
   * Removes an implicit task that turned out to be no task (no evidence, no edits): its rows
   * stay, counted toward the session but no task (ADR 0012).
   */
  drop(id: string): void {
    this.sql.transaction(() => {
      for (const table of ["messages", "model_calls", "tool_calls", "agents"]) {
        this.sql.query(`UPDATE ${table} SET task_id = NULL WHERE task_id = ?`).run(id);
      }
      this.sql.query("DELETE FROM tasks WHERE id = ? AND implicit = 1").run(id);
    })();
  }

  /** The session's open task, newest first if (against the rules) there are several. */
  openFor(sessionId: string): { id: string; implicit: boolean } | undefined {
    const r = this.sql
      .query<{ id: string; implicit: number }, [string]>(
        `SELECT id, implicit FROM tasks WHERE session_id = ? AND outcome = 'open'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId);
    return r ? { id: r.id, implicit: r.implicit === 1 } : undefined;
  }

  latestFor(sessionId: string): string | undefined {
    return (
      this.sql
        .query<{ id: string }, [string]>(
          "SELECT id FROM tasks WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(sessionId)?.id ?? undefined
    );
  }

  startedAt(id: string): number {
    return (
      this.sql
        .query<{ started_at: number }, [string]>("SELECT started_at FROM tasks WHERE id = ?")
        .get(id)?.started_at ?? Date.now()
    );
  }

  /** Stores what the agent submitted, as a pending claim. Returns the evidence id. */
  addClaim(taskId: string, claim: EvidenceClaim, toolCallId: string | undefined): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO evidence (id, task_id, kind, claim_json, tool_call_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, claim.kind, JSON.stringify(claim), toolCallId ?? null, now, now);
    return id;
  }

  /** Checked evidence (any result) and how many passed. Pending claims don't count. */
  evidenceCounts(taskId: string): { evidence: number; passed: number } {
    const r = this.sql
      .query<{ evidence: number; passed: number }, [string]>(
        `SELECT count(*) AS evidence, COALESCE(SUM(status = 'passed'), 0) AS passed
         FROM evidence WHERE task_id = ? AND status != 'pending'`,
      )
      .get(taskId);
    return { evidence: r?.evidence ?? 0, passed: r?.passed ?? 0 };
  }

  changedFiles(taskId: string): boolean {
    const r = this.sql
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM tool_calls WHERE task_id = ?
           AND tool IN (${MUTATING_TOOLS.map((t) => `'${t}'`).join(", ")})`,
      )
      .get(taskId);
    return (r?.n ?? 0) > 0;
  }

  view(id: string, now = Date.now()): TaskView | undefined {
    const t = this.sql
      .query<TaskRow, [string]>(
        `SELECT id, goal, implicit, outcome, summary, outcome_reason, started_at, ended_at
         FROM tasks WHERE id = ?`,
      )
      .get(id);
    if (!t) return undefined;
    const sums = this.sql
      .query<{ cost: number; tokens: number }, [string]>(
        `SELECT COALESCE(SUM(cost_micros), 0) AS cost,
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)
             AS tokens
         FROM model_calls WHERE task_id = ?`,
      )
      .get(id);
    const started = t.started_at;
    return {
      id: t.id,
      goal: t.goal,
      implicit: t.implicit === 1,
      outcome: t.outcome,
      ...(t.summary !== null ? { summary: t.summary } : {}),
      ...(t.outcome_reason !== null ? { reason: t.outcome_reason } : {}),
      ...this.evidenceCounts(id),
      costMicros: sums?.cost ?? 0,
      tokens: sums?.tokens ?? 0,
      startedAt: started,
      ...(t.ended_at !== null ? { endedAt: t.ended_at } : {}),
      durationMs: Math.max(0, (t.ended_at ?? now) - started),
    };
  }
}
