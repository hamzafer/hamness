import type { Migration } from "./types.ts";

/*
 * Safety decisions (ticket #4). The `decisions` table exists since 0001; this adds:
 * - `rule`: the rule that decided (`default: bash rm -rf *`), or `doom_loop`.
 * - `mode`: the session's safety mode when it decided (`ask`, `auto`, `yolo`).
 * - an index for `hamness audit`, which lists the latest decisions first.
 */
const sql = `
ALTER TABLE decisions ADD COLUMN rule TEXT;
ALTER TABLE decisions ADD COLUMN mode TEXT;
CREATE INDEX decisions_created ON decisions (created_at);
`;

export const safetyDecisions: Migration = { version: 3, name: "safety", sql };
