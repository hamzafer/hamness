import type { Database } from "bun:sqlite";
import { newId } from "../db/ids.ts";
import type { HandlerState } from "./handler.ts";

export type ImportSource = "claude-code" | "codex";

export interface ModelCallRow {
  sessionId: string;
  agentId: string;
  externalId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicros: number;
  at: number | null;
}

export interface Cursor {
  offset: number;
  size: number;
  mtimeMs: number;
  state: HandlerState;
}

/** Every write the importer makes. All upserts, so re-reading a line changes nothing. */
export class ImportStore {
  private readonly sessionIds = new Map<string, string>();

  private readonly q;

  constructor(private readonly sqlite: Database) {
    this.q = {
      session: sqlite.prepare<{ id: string }, [string, string, string, string, number, number]>(
        `INSERT INTO sessions (id, source, external_id, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET cwd = excluded.cwd WHERE sessions.cwd = '' AND excluded.cwd <> ''
         RETURNING id`,
      ),
      sessionId: sqlite.prepare<{ id: string }, [string, string]>(
        "SELECT id FROM sessions WHERE source = ? AND external_id = ?",
      ),
      touchSession: sqlite.prepare<
        unknown,
        [number | null, number | null, string | null, number, string]
      >(
        `UPDATE sessions SET
           started_at = coalesce(min(coalesce(started_at, ?1), ?1), started_at),
           ended_at = coalesce(max(coalesce(ended_at, ?2), ?2), ended_at),
           model = coalesce(?3, model),
           active_ms = CASE WHEN ?4 = 0 THEN active_ms ELSE max(0, coalesce(active_ms, 0) + ?4) END
         WHERE id = ?5`,
      ),
      agent: sqlite.prepare<
        { id: string },
        [string, string, string | null, string, string | null, string | null, number, number]
      >(
        `INSERT INTO agents (id, session_id, parent_agent_id, kind, external_id, name, model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'done', ?, ?)
         ON CONFLICT (session_id, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET name = coalesce(agents.name, excluded.name)
         RETURNING id`,
      ),
      touchAgent: sqlite.prepare<unknown, [number | null, number | null, string | null, string]>(
        `UPDATE agents SET
           started_at = coalesce(min(coalesce(started_at, ?1), ?1), started_at),
           ended_at = coalesce(max(coalesce(ended_at, ?2), ?2), ended_at),
           model = coalesce(model, ?3)
         WHERE id = ?4`,
      ),
      modelCall: sqlite.prepare(
        `INSERT INTO model_calls (id, session_id, agent_id, external_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros,
           started_at, created_at, updated_at)
         VALUES ($id, $session, $agent, $external, $provider, $model,
           $input, $output, $cacheRead, $cacheWrite, $cost, $at, $now, $now)
         ON CONFLICT (session_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           input_tokens = max(input_tokens, excluded.input_tokens),
           output_tokens = max(output_tokens, excluded.output_tokens),
           cache_read_tokens = max(cache_read_tokens, excluded.cache_read_tokens),
           cache_write_tokens = max(cache_write_tokens, excluded.cache_write_tokens),
           cost_micros = max(cost_micros, excluded.cost_micros)
         WHERE excluded.input_tokens > input_tokens OR excluded.output_tokens > output_tokens
           OR excluded.cache_read_tokens > cache_read_tokens
           OR excluded.cache_write_tokens > cache_write_tokens`,
      ),
      toolCall: sqlite.prepare<
        unknown,
        [string, string, string, string, string, number | null, number, number]
      >(
        `INSERT INTO tool_calls (id, session_id, agent_id, external_id, tool, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (session_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      ),
      finishTool: sqlite.prepare<unknown, [string, number | null, string, string]>(
        `UPDATE tool_calls SET status = ?1, ended_at = ?2,
           duration_ms = CASE WHEN ?2 IS NULL OR started_at IS NULL THEN NULL ELSE ?2 - started_at END
         WHERE session_id = ?3 AND external_id = ?4 AND status = 'pending'`,
      ),
      cursor: sqlite.prepare<
        { byte_offset: number; size: number; mtime_ms: number; state_json: string | null },
        [string]
      >("SELECT byte_offset, size, mtime_ms, state_json FROM import_files WHERE path_hash = ?"),
      saveCursor: sqlite.prepare<
        unknown,
        [string, string, string, number, number, number, string, number, number]
      >(
        `INSERT INTO import_files (id, source, path_hash, byte_offset, size, mtime_ms, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path_hash) DO UPDATE SET byte_offset = excluded.byte_offset,
           size = excluded.size, mtime_ms = excluded.mtime_ms, state_json = excluded.state_json`,
      ),
    };
  }

  /** The session row for a source's session id, made if needed. `cwd` '' means not known yet. */
  session(source: ImportSource, externalId: string, cwd: string): string {
    const key = `${source}\0${externalId}`;
    const known = this.sessionIds.get(key);
    if (known && cwd === "") return known;
    const now = Date.now();
    const row = this.q.session.get(newId(), source, externalId, cwd, now, now);
    const id = row?.id ?? this.q.sessionId.get(source, externalId)?.id;
    if (!id) throw new Error(`could not store session ${externalId}`);
    this.sessionIds.set(key, id);
    return id;
  }

  touchSession(
    id: string,
    span: { first: number | null; last: number | null; model: string | null; activeMs: number },
  ): void {
    this.q.touchSession.run(span.first, span.last, span.model, span.activeMs, id);
  }

  agent(
    sessionId: string,
    externalId: string,
    opts: { kind: "main" | "subagent"; name?: string | null; parentAgentId?: string | null },
  ): string {
    const now = Date.now();
    const row = this.q.agent.get(
      newId(),
      sessionId,
      opts.parentAgentId ?? null,
      opts.kind,
      externalId,
      opts.name ?? null,
      now,
      now,
    );
    if (!row) throw new Error(`could not store agent ${externalId}`);
    return row.id;
  }

  touchAgent(
    id: string,
    span: { first: number | null; last: number | null; model: string | null },
  ): void {
    this.q.touchAgent.run(span.first, span.last, span.model, id);
  }

  modelCall(c: ModelCallRow): void {
    this.q.modelCall.run({
      $id: newId(),
      $session: c.sessionId,
      $agent: c.agentId,
      $external: c.externalId,
      $provider: c.provider,
      $model: c.model,
      $input: c.input,
      $output: c.output,
      $cacheRead: c.cacheRead,
      $cacheWrite: c.cacheWrite,
      $cost: c.costMicros,
      $at: c.at,
      $now: c.at ?? Date.now(),
    });
  }

  toolCall(
    sessionId: string,
    agentId: string,
    externalId: string,
    tool: string,
    at: number | null,
  ) {
    const now = at ?? Date.now();
    this.q.toolCall.run(newId(), sessionId, agentId, externalId, tool, at, now, now);
  }

  finishToolCall(sessionId: string, externalId: string, ok: boolean, at: number | null): void {
    this.q.finishTool.run(ok ? "ok" : "error", at, sessionId, externalId);
  }

  cursor(pathHash: string): Cursor | undefined {
    const row = this.q.cursor.get(pathHash);
    if (!row) return undefined;
    return {
      offset: row.byte_offset,
      size: row.size,
      mtimeMs: row.mtime_ms,
      state: row.state_json ? JSON.parse(row.state_json) : {},
    };
  }

  saveCursor(source: ImportSource, pathHash: string, c: Cursor): void {
    const now = Date.now();
    this.q.saveCursor.run(
      newId(),
      source,
      pathHash,
      c.offset,
      c.size,
      c.mtimeMs,
      JSON.stringify(c.state),
      now,
      now,
    );
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
}
