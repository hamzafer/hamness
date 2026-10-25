import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { AgentTotals, ToolStatus, TranscriptItem } from "../events/types.ts";
import type { TokenUsage } from "../models/prices.ts";
import type { SubagentStatus } from "./subagent-tools.ts";

/**
 * The chat rows of the hamness database: sessions, agents, messages, tool calls and model calls.
 * Rows carry the `task_id` the hub passes in `ids` (ticket #6): the session's current task.
 */

/** Who a row belongs to. `taskId` is the task it counts toward, if any. */
export interface RowIds {
  sessionId: string;
  agentId: string;
  taskId?: string | undefined;
}
/** A stored hamness session, enough to start it again. */
export interface StoredSession {
  sessionId: string;
  agentId: string;
  cwd: string;
  model: string | null;
  piSessionId: string;
  name?: string;
  thinkingLevel?: string;
  safetyMode?: string;
}

interface StoredSessionRow {
  id: string;
  agent_id: string;
  cwd: string;
  model: string | null;
  external_id: string;
  title: string | null;
  thinking_level: string | null;
  safety_mode: string | null;
}

/** The session holds an open explicit task (it may have moved there with `/new`; ADR 0021). */
const OPEN_TASK = `EXISTS (SELECT 1 FROM tasks t WHERE t.session_id = s.id AND t.outcome = 'open'
    AND t.implicit = 0)`;

const STORED_SESSION = `SELECT s.id, a.id AS agent_id, s.cwd, s.model, s.external_id, s.title,
    s.thinking_level, s.safety_mode
  FROM sessions s JOIN agents a ON a.session_id = s.id AND a.kind = 'main'`;

function storedSession(r: StoredSessionRow): StoredSession {
  return {
    sessionId: r.id,
    agentId: r.agent_id,
    cwd: r.cwd,
    model: r.model,
    piSessionId: r.external_id,
    ...(r.title !== null ? { name: r.title } : {}),
    ...(r.thinking_level !== null ? { thinkingLevel: r.thinking_level } : {}),
    ...(r.safety_mode !== null ? { safetyMode: r.safety_mode } : {}),
  };
}

/** One row of `GET /v1/sessions?cwd=`, before the hub adds what only it knows. */
export interface SessionListRow {
  id: string;
  name?: string;
  piSessionId: string | null;
  startedAt: number;
  lastActivityAt: number;
  /** The main agent's user and assistant messages. */
  messageCount: number;
  /** All the session's model calls, subagents included. */
  costMicros: number;
  /** The main agent's first user message, for a session with no name. */
  firstPrompt?: string;
}

export interface SessionUsage {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  costMicros: number;
  /** Calls billed to the ChatGPT plan ($0 each). */
  planCalls: number;
}

export class ChatStore {
  constructor(private readonly db: HamnessDb) {}

  private get sql() {
    return this.db.sqlite;
  }

  /**
   * `piSessionId` goes in `sessions.external_id`, so the session can resume after a restart.
   * `ids` and `startedAt` are given when the hub picked them before storing the row.
   */
  createSession(
    cwd: string,
    model: string,
    piSessionId?: string,
    opts: { ids?: { sessionId: string; agentId: string }; startedAt?: number } = {},
  ): { sessionId: string; agentId: string } {
    const now = opts.startedAt ?? Date.now();
    const sessionId = opts.ids?.sessionId ?? newId();
    const agentId = opts.ids?.agentId ?? newId();
    this.sql.transaction(() => {
      this.sql
        .query(
          `INSERT INTO sessions (id, source, external_id, cwd, model, started_at, created_at, updated_at,
             picked_at)
           VALUES (?, 'hamness', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, piSessionId ?? null, cwd, model, now, now, now, now);
      this.sql
        .query(
          `INSERT INTO agents (id, session_id, kind, model, status, started_at, created_at, updated_at)
           VALUES (?, ?, 'main', ?, 'running', ?, ?, ?)`,
        )
        .run(agentId, sessionId, model, now, now, now);
    })();
    return { sessionId, agentId };
  }

  /**
   * The cwd's most recent hamness session that has a message and a Pi session id:
   * the one to resume after a daemon restart.
   */
  latestSession(cwd: string): StoredSession | undefined {
    const row = this.sql
      .query<StoredSessionRow, [string]>(
        `${STORED_SESSION}
         WHERE s.source = 'hamness' AND s.cwd = ? AND s.external_id IS NOT NULL
           AND (EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id) OR ${OPEN_TASK})
         ORDER BY coalesce(s.picked_at, s.updated_at) DESC, s.id DESC LIMIT 1`,
      )
      .get(cwd);
    return row ? storedSession(row) : undefined;
  }

  /** A hamness session's row, to resume it by id. */
  session(sessionId: string): StoredSession | undefined {
    const row = this.sql
      .query<StoredSessionRow, [string]>(
        `${STORED_SESSION} WHERE s.source = 'hamness' AND s.id = ? AND s.external_id IS NOT NULL`,
      )
      .get(sessionId);
    return row ? storedSession(row) : undefined;
  }

  /** The cwd's hamness sessions that hold a message or a name, the most recently active first. */
  listSessions(cwd: string): SessionListRow[] {
    return this.sql
      .query<
        {
          id: string;
          title: string | null;
          external_id: string | null;
          started_at: number | null;
          created_at: number;
          last_at: number | null;
          messages: number;
          cost: number;
          first: string | null;
        },
        [string]
      >(
        `SELECT s.id, s.title, s.external_id, s.started_at, s.created_at,
           (SELECT max(m.created_at) FROM messages m WHERE m.session_id = s.id) AS last_at,
           (SELECT count(*) FROM messages m WHERE m.session_id = s.id
              AND m.role IN ('user', 'assistant')
              AND m.agent_id = (SELECT a.id FROM agents a WHERE a.session_id = s.id
                                AND a.kind = 'main')) AS messages,
           (SELECT coalesce(sum(mc.cost_micros), 0) FROM model_calls mc
              WHERE mc.session_id = s.id) AS cost,
           (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
              AND m.agent_id = (SELECT a.id FROM agents a WHERE a.session_id = s.id
                                AND a.kind = 'main')
              ORDER BY m.created_at, m.rowid LIMIT 1) AS first
         FROM sessions s
         WHERE s.source = 'hamness' AND s.cwd = ?
           AND (s.title IS NOT NULL OR ${OPEN_TASK}
             OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id))
         ORDER BY coalesce(last_at, s.started_at, s.created_at) DESC, s.id DESC`,
      )
      .all(cwd)
      .map((r) => {
        const startedAt = r.started_at ?? r.created_at;
        return {
          id: r.id,
          ...(r.title !== null ? { name: r.title } : {}),
          piSessionId: r.external_id,
          startedAt,
          lastActivityAt: r.last_at ?? startedAt,
          messageCount: r.messages,
          costMicros: r.cost,
          ...(r.first ? { firstPrompt: r.first } : {}),
        };
      });
  }

  /** The session ended (`/new`, `/resume` of another, `/fork`): its main agent is done. */
  endSession(ids: { sessionId: string; agentId: string }): void {
    const now = Date.now();
    this.sql.transaction(() => {
      this.sql
        .query("UPDATE sessions SET ended_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, ids.sessionId);
      this.sql
        .query("UPDATE agents SET status = 'done', ended_at = ? WHERE id = ?")
        .run(now, ids.agentId);
    })();
  }

  /**
   * A resumed or woken session runs again. Status only: `updated_at` stays, so a wake never
   * makes a session the cwd's latest; `/resume`, `-r` and `-c` do that with `makeLatest`.
   */
  reopenSession(ids: { sessionId: string; agentId: string }): void {
    this.sql.transaction(() => {
      this.sql.query("UPDATE sessions SET ended_at = NULL WHERE id = ?").run(ids.sessionId);
      this.sql
        .query("UPDATE agents SET status = 'running', ended_at = NULL WHERE id = ?")
        .run(ids.agentId);
    })();
  }

  /**
   * Makes the session the cwd's latest (`picked_at`), the one `hamness -c` continues, even
   * when another of the cwd's sessions was picked in the same millisecond.
   */
  makeLatest(sessionId: string, cwd: string): void {
    this.sql
      .query(
        `UPDATE sessions SET picked_at = max(?, 1 + (SELECT max(coalesce(picked_at, updated_at))
           FROM sessions
           WHERE source = 'hamness' AND cwd = ?)) WHERE id = ?`,
      )
      .run(Date.now(), cwd, sessionId);
  }

  /** Points a session that had no Pi file yet at a new one (a task holder; ADR 0021). */
  setPiSessionId(sessionId: string, piSessionId: string): void {
    this.sql.query("UPDATE sessions SET external_id = ? WHERE id = ?").run(piSessionId, sessionId);
  }

  /** Whether the session has any message: without one, Pi never wrote its file. */
  hasMessages(sessionId: string): boolean {
    return !!this.sql
      .query<{ id: string }, [string]>("SELECT id FROM messages WHERE session_id = ? LIMIT 1")
      .get(sessionId);
  }

  /** The user's settings for a session: its name, thinking level and safety mode. */
  setSessionSettings(
    sessionId: string,
    s: { name?: string; thinkingLevel?: string; safetyMode?: string },
  ): void {
    const set = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      this.sql
        .query(`UPDATE sessions SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(value, Date.now(), sessionId);
    };
    set("title", s.name);
    set("thinking_level", s.thinkingLevel);
    set("safety_mode", s.safetyMode);
  }

  /** Pi's session entry id for a user message (`/fork`). */
  setMessageExternalId(messageId: string, externalId: string): void {
    this.sql.query("UPDATE messages SET external_id = ? WHERE id = ?").run(externalId, messageId);
  }

  /** One of the main agent's messages, for `/fork`. */
  mainMessage(
    ids: { sessionId: string; agentId: string },
    messageId: string,
  ): { role: string; text: string; externalId: string | null } | undefined {
    const row = this.sql
      .query<
        { role: string; content: string | null; external_id: string | null },
        [string, string, string]
      >(
        "SELECT role, content, external_id FROM messages WHERE id = ? AND session_id = ? AND agent_id = ?",
      )
      .get(messageId, ids.sessionId, ids.agentId);
    return row
      ? { role: row.role, text: row.content ?? "", externalId: row.external_id }
      : undefined;
  }

  /**
   * Copies the main agent's messages and tool calls before `beforeId` into a forked session, so
   * its transcript shows the history it continues. Model calls stay with the original: the
   * spend happened once.
   */
  copyTranscript(
    from: { sessionId: string; agentId: string },
    to: { sessionId: string; agentId: string },
    beforeId: string,
  ): void {
    const messages = this.sql
      .query<
        {
          id: string;
          role: string;
          content: string | null;
          external_id: string | null;
          created_at: number;
        },
        [string, string, string]
      >(
        `SELECT id, role, content, external_id, created_at FROM messages
         WHERE session_id = ? AND agent_id = ? AND id < ? ORDER BY id`,
      )
      .all(from.sessionId, from.agentId, beforeId);
    const tools = this.sql
      .query<
        {
          id: string;
          message_id: string | null;
          tool: string;
          args_json: string | null;
          status: string;
          result_summary: string | null;
          duration_ms: number | null;
          started_at: number | null;
          ended_at: number | null;
        },
        [string, string, string]
      >(
        `SELECT id, message_id, tool, args_json, status, result_summary, duration_ms, started_at,
           ended_at FROM tool_calls WHERE session_id = ? AND agent_id = ? AND id < ? ORDER BY id`,
      )
      .all(from.sessionId, from.agentId, beforeId);
    // New ids in the original order: the transcript sorts by id.
    const rows = [
      ...messages.map((m) => ({ kind: "m" as const, id: m.id, m })),
      ...tools.map((t) => ({ kind: "t" as const, id: t.id, t })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const now = Date.now();
    const newIds = new Map<string, string>();
    this.sql.transaction(() => {
      for (const r of rows) {
        const id = newId();
        newIds.set(r.id, id);
        if (r.kind === "m") {
          this.sql
            .query(
              `INSERT INTO messages (id, session_id, agent_id, role, content, external_id,
                 created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              to.sessionId,
              to.agentId,
              r.m.role,
              r.m.content,
              r.m.external_id,
              r.m.created_at,
              now,
            );
        } else {
          const t = r.t;
          this.sql
            .query(
              `INSERT INTO tool_calls (id, session_id, agent_id, message_id, tool, args_json, status,
                 result_summary, duration_ms, started_at, ended_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              to.sessionId,
              to.agentId,
              t.message_id ? (newIds.get(t.message_id) ?? null) : null,
              t.tool,
              t.args_json,
              // A call still running in the original is not running here.
              t.status === "running" || t.status === "pending" ? "error" : t.status,
              t.result_summary,
              t.duration_ms,
              t.started_at,
              t.ended_at,
              now,
              now,
            );
        }
      }
    })();
  }

  /**
   * The cwd's most recent open explicit task held by another session than `except`, for the
   * hint a fresh launch shows (ADR 0023).
   */
  openTaskIn(cwd: string, except: string): { sessionId: string; goal: string } | undefined {
    const row = this.sql
      .query<{ session_id: string; goal: string }, [string, string]>(
        `SELECT t.session_id, t.goal FROM tasks t JOIN sessions s ON s.id = t.session_id
         WHERE s.source = 'hamness' AND s.cwd = ? AND s.id != ? AND t.outcome = 'open'
           AND t.implicit = 0
         ORDER BY s.updated_at DESC, t.created_at DESC LIMIT 1`,
      )
      .get(cwd, except);
    return row ? { sessionId: row.session_id, goal: row.goal } : undefined;
  }

  /**
   * Whether `/new`, `/resume` or `/fork` left the session (`endSession`: its main agent is
   * `done`). `sessions.ended_at` alone does not say: each run sets it too (`endRun`).
   */
  wasLeft(sessionId: string): boolean {
    return !!this.sql
      .query<{ id: string }, [string]>(
        "SELECT id FROM agents WHERE session_id = ? AND kind = 'main' AND status = 'done'",
      )
      .get(sessionId);
  }

  hasOpenExplicitTask(sessionId: string): boolean {
    return !!this.sql
      .query<{ id: string }, [string]>(
        "SELECT id FROM tasks WHERE session_id = ? AND outcome = 'open' AND implicit = 0 LIMIT 1",
      )
      .get(sessionId);
  }

  /** The session's open task moves to another session (`/new`, `/fork`; ADR 0021). */
  moveOpenTask(fromSessionId: string, toSessionId: string): string | undefined {
    const row = this.sql
      .query<{ id: string }, [string]>(
        "SELECT id FROM tasks WHERE session_id = ? AND outcome = 'open' AND implicit = 0 LIMIT 1",
      )
      .get(fromSessionId);
    if (!row) return undefined;
    this.sql.query("UPDATE tasks SET session_id = ? WHERE id = ?").run(toSessionId, row.id);
    return row.id;
  }

  /** The session's stored usage over all its agents, and its main agent's message counts. */
  sessionUsage(sessionId: string): SessionUsage {
    const t = this.sql
      .query<
        {
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
          cost: number;
          plan: number;
        },
        [string]
      >(
        `SELECT coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
           coalesce(sum(cache_read_tokens), 0) AS cache_read,
           coalesce(sum(cache_write_tokens), 0) AS cache_write,
           coalesce(sum(cost_micros), 0) AS cost,
           coalesce(sum(billing = 'plan'), 0) AS plan
         FROM model_calls WHERE session_id = ?`,
      )
      .get(sessionId);
    const input = t?.input ?? 0;
    const output = t?.output ?? 0;
    const cacheRead = t?.cache_read ?? 0;
    const cacheWrite = t?.cache_write ?? 0;
    return {
      tokens: {
        input,
        output,
        cacheRead,
        cacheWrite,
        total: input + output + cacheRead + cacheWrite,
      },
      costMicros: t?.cost ?? 0,
      planCalls: t?.plan ?? 0,
    };
  }

  /** A subagent row, queued until it starts. */
  createSubagent(sub: {
    sessionId: string;
    parentAgentId: string;
    taskId?: string;
    name: string;
    model: string;
  }): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO agents (id, session_id, parent_agent_id, task_id, kind, name, model, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'subagent', ?, ?, 'queued', ?, ?)`,
      )
      .run(id, sub.sessionId, sub.parentAgentId, sub.taskId ?? null, sub.name, sub.model, now, now);
    return id;
  }

  /** A subagent's status: `running` sets its start, the finished states its end. */
  setAgentStatus(agentId: string, status: SubagentStatus): void {
    const now = Date.now();
    if (status === "running") {
      this.sql
        .query("UPDATE agents SET status = ?, started_at = ? WHERE id = ?")
        .run(status, now, agentId);
    } else if (status === "queued") {
      this.sql.query("UPDATE agents SET status = ? WHERE id = ?").run(status, agentId);
    } else {
      this.sql
        .query("UPDATE agents SET status = ?, ended_at = ? WHERE id = ?")
        .run(status, now, agentId);
    }
  }

  setAgentWorktree(agentId: string, path: string): void {
    this.sql.query("UPDATE agents SET worktree_path = ? WHERE id = ?").run(path, agentId);
  }

  /** Subagents a previous daemon left queued or running: they died with it. */
  abortStaleSubagents(): void {
    this.sql
      .query(
        `UPDATE agents SET status = 'aborted', ended_at = ?
         WHERE kind = 'subagent' AND status IN ('queued', 'running')`,
      )
      .run(Date.now());
  }

  /** The session's current model, on the session and its main agent. */
  setModel(ids: { sessionId: string; agentId: string }, model: string): void {
    const now = Date.now();
    this.sql.transaction(() => {
      this.sql
        .query("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
        .run(model, now, ids.sessionId);
      this.sql
        .query("UPDATE agents SET model = ?, updated_at = ? WHERE id = ?")
        .run(model, now, ids.agentId);
    })();
  }

  /** A run of the main agent ended: its duration counts as active time, and the session ends now (for now). */
  endRun(sessionId: string, durationMs: number): void {
    const now = Date.now();
    this.sql
      .query(
        `UPDATE sessions SET active_ms = coalesce(active_ms, 0) + ?, ended_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(Math.max(0, Math.round(durationMs)), now, now, sessionId);
  }

  addMessage(ids: RowIds, role: "user" | "assistant", content: string | null): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO messages (id, session_id, agent_id, task_id, role, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ids.sessionId, ids.agentId, ids.taskId ?? null, role, content, now, now);
    return id;
  }

  setMessageContent(id: string, content: string): void {
    this.sql.query("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
  }

  addModelCall(
    ids: RowIds,
    call: {
      /** The reply it made; none for a compaction summary. */
      messageId?: string | undefined;
      provider: string;
      model: string;
      usage: TokenUsage;
      costMicros: number;
      durationMs?: number;
      /** `plan`: billed to the ChatGPT plan ($0). */
      billing?: "plan" | "api";
    },
  ): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO model_calls (id, session_id, agent_id, task_id, message_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros,
           duration_ms, started_at, created_at, updated_at, billing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ids.sessionId,
        ids.agentId,
        ids.taskId ?? null,
        call.messageId ?? null,
        call.provider,
        call.model,
        call.usage.input,
        call.usage.output,
        call.usage.cacheRead,
        call.usage.cacheWrite,
        call.costMicros,
        call.durationMs ?? null,
        call.durationMs === undefined ? null : now - call.durationMs,
        now,
        now,
        call.billing ?? null,
      );
    return id;
  }

  /** `argsJson` must already be redacted. */
  addToolCall(
    ids: RowIds,
    call: { messageId: string | undefined; tool: string; argsJson: string },
  ): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO tool_calls (id, session_id, agent_id, task_id, message_id, tool, args_json,
           status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        ids.sessionId,
        ids.agentId,
        ids.taskId ?? null,
        call.messageId ?? null,
        call.tool,
        call.argsJson,
        now,
        now,
        now,
      );
    return id;
  }

  finishToolCall(
    id: string,
    end: { status: Exclude<ToolStatus, "running">; summary: string; durationMs?: number },
  ): void {
    this.sql
      .query(
        `UPDATE tool_calls SET status = ?, result_summary = ?, duration_ms = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(end.status, end.summary, end.durationMs ?? null, Date.now(), id);
  }

  /** Each agent of a session with its stored tokens and cost, oldest first. */
  agentTotals(sessionId: string): AgentTotals[] {
    return this.sql
      .query<
        {
          id: string;
          kind: "main" | "subagent";
          name: string | null;
          status: string;
          tokens: number;
          cost: number;
        },
        [string]
      >(
        `SELECT a.id, a.kind, a.name, a.status,
           COALESCE(SUM(mc.input_tokens + mc.output_tokens + mc.cache_read_tokens
             + mc.cache_write_tokens), 0) AS tokens,
           COALESCE(SUM(mc.cost_micros), 0) AS cost
         FROM agents a LEFT JOIN model_calls mc ON mc.agent_id = a.id
         WHERE a.session_id = ? GROUP BY a.id ORDER BY a.id`,
      )
      .all(sessionId)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        ...(a.name !== null ? { name: a.name } : {}),
        ...(a.kind === "subagent" ? { status: a.status as SubagentStatus } : {}),
        tokens: a.tokens,
        costMicros: a.cost,
      }));
  }

  /**
   * Messages and tool calls in the order they happened (ids are time-ordered UUIDv7).
   * With `agentId`, only that agent's (the chat pane shows the main agent, not its subagents).
   */
  transcript(sessionId: string, agentId?: string): TranscriptItem[] {
    const agent = agentId ?? null;
    const messages = this.sql
      .query<
        { id: string; role: "user" | "assistant"; content: string | null },
        [string, string | null, string | null]
      >(
        `SELECT id, role, content FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant') AND (? IS NULL OR agent_id = ?)`,
      )
      .all(sessionId, agent, agent)
      .map(
        (m): TranscriptItem => ({ kind: "message", id: m.id, role: m.role, text: m.content ?? "" }),
      );
    const tools = this.sql
      .query<
        {
          id: string;
          tool: string;
          args_json: string | null;
          status: string;
          result_summary: string | null;
          duration_ms: number | null;
        },
        [string, string | null, string | null]
      >(
        `SELECT id, tool, args_json, status, result_summary, duration_ms FROM tool_calls
         WHERE session_id = ? AND (? IS NULL OR agent_id = ?)`,
      )
      .all(sessionId, agent, agent)
      .map(
        (t): TranscriptItem => ({
          kind: "tool",
          id: t.id,
          tool: t.tool,
          args: t.args_json ? (JSON.parse(t.args_json) as Record<string, unknown>) : {},
          status: t.status === "pending" ? "running" : (t.status as ToolStatus),
          ...(t.result_summary !== null ? { summary: t.result_summary } : {}),
          ...(t.duration_ms !== null ? { durationMs: t.duration_ms } : {}),
        }),
      );
    return [...messages, ...tools].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
