import type { Migration } from "./types.ts";

/*
 * Conventions for every table (ADR 0007):
 * - `id` TEXT primary key, a UUIDv7 made by hamness (stable across a later sync).
 * - `created_at` / `updated_at` INTEGER, milliseconds since the Unix epoch.
 *   A trigger bumps `updated_at` on any update that does not set it.
 * - Money is INTEGER micro-dollars (`cost_micros`), never floats.
 * - JSON payloads are TEXT columns ending in `_json`.
 *
 * Never edit a shipped migration. Add a new file instead.
 */

const tables = [
  "sessions",
  "tasks",
  "agents",
  "messages",
  "model_calls",
  "tool_calls",
  "decisions",
  "evidence",
] as const;

const touchTrigger = (table: string) => `
CREATE TRIGGER ${table}_touch AFTER UPDATE ON ${table}
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ${table} SET updated_at = max(OLD.updated_at + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  WHERE id = NEW.id;
END;`;

const sql = `
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('hamness', 'claude-code', 'codex')),
  external_id  TEXT,
  cwd          TEXT NOT NULL,
  title        TEXT,
  model        TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX sessions_source_external ON sessions (source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (id),
  goal         TEXT NOT NULL,
  summary      TEXT,
  implicit     INTEGER NOT NULL DEFAULT 0 CHECK (implicit IN (0, 1)),
  outcome      TEXT NOT NULL DEFAULT 'open'
               CHECK (outcome IN ('open', 'verified', 'unverified', 'overridden', 'abandoned')),
  branch       TEXT,
  commit_sha   TEXT,
  pr_url       TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX tasks_session ON tasks (session_id);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions (id),
  parent_agent_id  TEXT REFERENCES agents (id),
  task_id          TEXT REFERENCES tasks (id),
  kind             TEXT NOT NULL CHECK (kind IN ('main', 'subagent')),
  name             TEXT,
  model            TEXT,
  worktree_path    TEXT,
  status           TEXT NOT NULL DEFAULT 'running',
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX agents_session ON agents (session_id);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions (id),
  agent_id    TEXT REFERENCES agents (id),
  task_id     TEXT REFERENCES tasks (id),
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT, -- NULL for imported history (no message text by default)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX messages_session ON messages (session_id, created_at);

CREATE TABLE model_calls (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions (id),
  agent_id            TEXT REFERENCES agents (id),
  task_id             TEXT REFERENCES tasks (id),
  message_id          TEXT REFERENCES messages (id),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_micros         INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  started_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX model_calls_task ON model_calls (task_id);
CREATE INDEX model_calls_session ON model_calls (session_id, created_at);

CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (id),
  agent_id        TEXT REFERENCES agents (id),
  task_id         TEXT REFERENCES tasks (id),
  message_id      TEXT REFERENCES messages (id),
  tool            TEXT NOT NULL,
  args_json       TEXT, -- secrets redacted before storing
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'ok', 'error', 'denied')),
  result_summary  TEXT,
  duration_ms     INTEGER,
  started_at      INTEGER,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX tool_calls_session ON tool_calls (session_id, created_at);
CREATE INDEX tool_calls_task ON tool_calls (task_id);

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions (id),
  tool_call_id  TEXT REFERENCES tool_calls (id),
  tool          TEXT NOT NULL,
  args_json     TEXT, -- secrets redacted before storing
  verdict       TEXT NOT NULL CHECK (verdict IN ('allow', 'ask', 'deny')),
  source        TEXT NOT NULL CHECK (source IN ('rule', 'judge', 'hook', 'user', 'mode')),
  reason        TEXT,
  category      TEXT,
  latency_ms    INTEGER,
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX decisions_session ON decisions (session_id, created_at);

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks (id),
  kind         TEXT NOT NULL CHECK (kind IN ('command', 'ci', 'file', 'url')),
  claim_json   TEXT NOT NULL,  -- what the agent submitted
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'passed', 'failed', 'error')),
  result_json  TEXT,           -- written only by a checker
  checked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX evidence_task ON evidence (task_id);

${tables.map(touchTrigger).join("\n")}
`;

export const initial: Migration = { version: 1, name: "initial", sql };
