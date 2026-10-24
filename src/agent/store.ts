import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { AgentTotals, ToolStatus, TranscriptItem } from "../events/types.ts";
import type { TokenUsage } from "../models/prices.ts";

/**
 * The chat rows of the hamness database: sessions, agents, messages, tool calls and model calls.
 * `task_id` stays NULL until ticket #6 opens tasks.
 */
export class ChatStore {
  constructor(private readonly db: HamnessDb) {}

  private get sql() {
    return this.db.sqlite;
  }

  /** `piSessionId` goes in `sessions.external_id`, so the session can resume after a restart. */
  createSession(
    cwd: string,
    model: string,
    piSessionId?: string,
  ): { sessionId: string; agentId: string } {
    const now = Date.now();
    const sessionId = newId();
    const agentId = newId();
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

  addMessage(
    ids: { sessionId: string; agentId: string },
    role: "user" | "assistant",
    content: string | null,
  ): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO messages (id, session_id, agent_id, role, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ids.sessionId, ids.agentId, role, content, now, now);
    return id;
  }

  setMessageContent(id: string, content: string): void {
    this.sql.query("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
  }

  addModelCall(
    ids: { sessionId: string; agentId: string },
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
        `INSERT INTO model_calls (id, session_id, agent_id, message_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros,
           duration_ms, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ids.sessionId,
        ids.agentId,
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
    ids: { sessionId: string; agentId: string },
    call: { messageId: string | undefined; tool: string; argsJson: string },
  ): string {
    const id = newId();
    const now = Date.now();
    this.sql
      .query(
        `INSERT INTO tool_calls (id, session_id, agent_id, message_id, tool, args_json, status,
           started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        ids.sessionId,
        ids.agentId,
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
          tokens: number;
          cost: number;
        },
        [string]
      >(
        `SELECT a.id, a.kind, a.name,
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
        tokens: a.tokens,
        costMicros: a.cost,
      }));
  }

  /** Messages and tool calls in the order they happened (ids are time-ordered UUIDv7). */
  transcript(sessionId: string): TranscriptItem[] {
    const messages = this.sql
      .query<{ id: string; role: "user" | "assistant"; content: string | null }, [string]>(
        `SELECT id, role, content FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant')`,
      )
      .all(sessionId)
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
        [string]
      >(
        `SELECT id, tool, args_json, status, result_summary, duration_ms FROM tool_calls
         WHERE session_id = ?`,
      )
      .all(sessionId)
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
