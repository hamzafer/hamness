import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { ToolStatus, TranscriptItem } from "../events/types.ts";
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

  createSession(cwd: string, model: string): { sessionId: string; agentId: string } {
    const now = Date.now();
    const sessionId = newId();
    const agentId = newId();
    this.sql.transaction(() => {
      this.sql
        .query(
          `INSERT INTO sessions (id, source, cwd, model, started_at, created_at, updated_at)
           VALUES (?, 'hamness', ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, cwd, model, now, now, now);
      this.sql
        .query(
          `INSERT INTO agents (id, session_id, kind, model, status, started_at, created_at, updated_at)
           VALUES (?, ?, 'main', ?, 'running', ?, ?, ?)`,
        )
        .run(agentId, sessionId, model, now, now, now);
    })();
    return { sessionId, agentId };
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
