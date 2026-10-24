import type { Migration } from "./types.ts";

/*
 * Import of Claude Code and Codex history (ticket #10).
 *
 * - `import_files`: one row per source file read, keyed by a hash of its path
 *   (no home paths in the database). `byte_offset` is where the next read
 *   starts, so a re-run reads only appended lines. `state_json` carries what a
 *   later read needs from earlier lines (e.g. Codex's current model).
 * - `external_id` on agents, model_calls and tool_calls: the source's own id
 *   (API message id, tool_use id, Codex call id), unique per session, so
 *   re-importing the same lines is a no-op.
 * - `sessions.active_ms`: time the agent was working (sum of turn durations),
 *   next to the wall time of `started_at`..`ended_at`.
 */
const sql = `
CREATE TABLE import_files (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('claude-code', 'codex')),
  path_hash    TEXT NOT NULL UNIQUE,
  byte_offset  INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL DEFAULT 0,
  mtime_ms     INTEGER NOT NULL DEFAULT 0,
  state_json   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

ALTER TABLE agents ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX agents_session_external ON agents (session_id, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE model_calls ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX model_calls_session_external ON model_calls (session_id, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE tool_calls ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX tool_calls_session_external ON tool_calls (session_id, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE sessions ADD COLUMN active_ms INTEGER;

CREATE TRIGGER import_files_touch AFTER UPDATE ON import_files
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE import_files SET updated_at = max(OLD.updated_at + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  WHERE id = NEW.id;
END;
`;

export const importTables: Migration = { version: 2, name: "import", sql };
