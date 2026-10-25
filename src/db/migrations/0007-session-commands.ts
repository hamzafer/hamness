import type { Migration } from "./types.ts";

/*
 * Session commands (`/new`, `/resume`, `/fork`, `/thinking`, `/name`, `/mode`; ADR 0021).
 * The session's name goes in `sessions.title`, which exists since 0001.
 *
 * - `sessions.thinking_level`: Pi's thinking level, restored when the session resumes.
 * - `sessions.safety_mode`: the user's mode for this session (`ask`, `auto`, `yolo`); NULL
 *   follows the user config's mode.
 * - `messages.external_id`: Pi's session entry id for a user message, so `/fork` can branch
 *   Pi's session file at that message.
 * - an index for listing a cwd's sessions.
 */
const sql = `
ALTER TABLE sessions ADD COLUMN thinking_level TEXT;
ALTER TABLE sessions ADD COLUMN safety_mode TEXT
  CHECK (safety_mode IS NULL OR safety_mode IN ('ask', 'auto', 'yolo'));
ALTER TABLE messages ADD COLUMN external_id TEXT;
CREATE INDEX sessions_cwd ON sessions (source, cwd);
`;

export const sessionCommands: Migration = { version: 7, name: "session-commands", sql };
