import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { GateEvidence } from "./gate.ts";
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
  branch: string | null;
  commit_sha: string | null;
  pr_url: string | null;
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

  open(sessionId: string, goal: string, implicit: boolean, branch?: string): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO tasks (id, session_id, goal, implicit, outcome, branch, started_at, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(id, sessionId, goal, implicit ? 1 : 0, branch ?? null, now, now, now);
    return id;
  }

  /** The PR and commit from the task's passing CI evidence (the latest wins). */
  setLinks(id: string, links: { prUrl?: string; commitSha?: string }): void {
    this.sql
      .query(
        `UPDATE tasks SET pr_url = COALESCE(?, pr_url), commit_sha = COALESCE(?, commit_sha)
         WHERE id = ?`,
      )
      .run(links.prUrl || null, links.commitSha || null, id);
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
      // Checks that could not run (R-L3): with no task left they belong to nothing.
      this.sql.query("DELETE FROM evidence WHERE task_id = ?").run(id);
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

  /** How many pieces of evidence failed (not `error`: that one checked nothing). */
  failedCount(taskId: string): number {
    return (
      this.sql
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM evidence WHERE task_id = ? AND status = 'failed'",
        )
        .get(taskId)?.n ?? 0
    );
  }

  /** The task's evidence as the gate reads it (`gate.ts`). */
  gateEvidence(taskId: string): GateEvidence[] {
    return this.sql
      .query<
        {
          id: string;
          status: GateEvidence["status"];
          created_at: number;
          result_json: string | null;
        },
        [string]
      >("SELECT id, status, created_at, result_json FROM evidence WHERE task_id = ?")
      .all(taskId)
      .map((r) => {
        let result: { weak?: unknown; summary?: unknown } = {};
        try {
          result = r.result_json ? JSON.parse(r.result_json) : {};
        } catch {}
        return {
          id: r.id,
          status: r.status,
          createdAt: r.created_at,
          weak: result.weak === true,
          ...(typeof result.summary === "string" ? { summary: result.summary } : {}),
        };
      });
  }

  /**
   * When the task last changed a file through write / edit, by any of its agents. A call still
   * running counts as now (Infinity); a denied one changed nothing. Undefined: no changes.
   */
  lastFileChange(taskId: string): number | undefined {
    const r = this.sql
      .query<{ running: number; last: number | null }, [string]>(
        `SELECT COALESCE(SUM(ended_at IS NULL), 0) AS running,
           MAX(COALESCE(ended_at, started_at, created_at)) AS last
         FROM tool_calls WHERE task_id = ? AND status != 'denied'
           AND tool IN (${MUTATING_TOOLS.map((t) => `'${t}'`).join(", ")})`,
      )
      .get(taskId);
    if (!r || r.last === null) return undefined;
    return r.running > 0 ? Number.POSITIVE_INFINITY : r.last;
  }

  /** The real paths the task's write / edit calls named, resolved against `cwd`. */
  writtenPaths(taskId: string, cwd: string): Set<string> {
    const rows = this.sql
      .query<{ args_json: string | null }, [string]>(
        `SELECT args_json FROM tool_calls WHERE task_id = ? AND status != 'denied'
           AND tool IN (${MUTATING_TOOLS.map((t) => `'${t}'`).join(", ")})`,
      )
      .all(taskId);
    const out = new Set<string>();
    for (const r of rows) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.args_json ?? "{}");
      } catch {}
      const p = args.path ?? args.file_path;
      if (typeof p !== "string" || !p) continue;
      const abs = resolve(cwd, p.startsWith("@") ? p.slice(1) : p);
      out.add(abs);
      try {
        out.add(realpathSync(abs));
      } catch {}
    }
    return out;
  }

  /** Whether the task started subagents (ADR 0015): their rows keep counting toward it. */
  hasSubagents(taskId: string): boolean {
    const r = this.sql
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM agents WHERE task_id = ? AND kind = 'subagent'",
      )
      .get(taskId);
    return (r?.n ?? 0) > 0;
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
        `SELECT id, goal, implicit, outcome, summary, outcome_reason, started_at, ended_at,
           branch, commit_sha, pr_url
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
      ...(t.branch ? { branch: t.branch } : {}),
      ...(t.pr_url ? { prUrl: t.pr_url } : {}),
      ...(t.commit_sha ? { commitSha: t.commit_sha } : {}),
    };
  }
}
