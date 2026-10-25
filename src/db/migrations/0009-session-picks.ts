import type { Migration } from "./types.ts";

/*
 * `sessions.picked_at` (ADR 0023): when the session last became its cwd's latest, the one
 * `hamness -c` continues: started, prompted, or picked with `/resume`, `-r` or `-c`.
 * `updated_at` can't say it: every write to the row touches it, waking a session too.
 * Older rows start from their `updated_at`.
 */
const sql = `
ALTER TABLE sessions ADD COLUMN picked_at INTEGER;
UPDATE sessions SET picked_at = updated_at WHERE source = 'hamness';
`;

export const sessionPicks: Migration = { version: 9, name: "session-picks", sql };
