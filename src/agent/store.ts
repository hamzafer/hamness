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
          `INSERT INTO sessions (id, source, external_id, cwd, model, started_at, created_at, updated_at)
           VALUES (?, 'hamness', ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, piSessionId ?? null, cwd, model, now, now, now);
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
  latestSession(
    cwd: string,
  ): { sessionId: string; agentId: string; model: string | null; piSessionId: string } | undefined {
    const row = this.sql
      .query<{ id: string; agent_id: string; model: string | null; external_id: string }, [string]>(
        `SELECT s.id, a.id AS agent_id, s.model, s.external_id
         FROM sessions s JOIN agents a ON a.session_id = s.id AND a.kind = 'main'
         WHERE s.source = 'hamness' AND s.cwd = ? AND s.external_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         ORDER BY s.started_at DESC, s.id DESC LIMIT 1`,
      )
      .get(cwd);
    return row
      ? { sessionId: row.id, agentId: row.agent_id, model: row.model, piSessionId: row.external_id }
      : undefined;
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
      messageId: string;
      provider: string;
      model: string;
      usage: TokenUsage;
      costMicros: number;
      durationMs?: number;
    },
  ): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO model_calls (id, session_id, agent_id, task_id, message_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros,
           duration_ms, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ids.sessionId,
        ids.agentId,
        ids.taskId ?? null,
        call.messageId,
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
