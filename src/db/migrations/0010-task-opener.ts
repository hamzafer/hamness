import type { Migration } from "./types.ts";

/*
 * `tasks.opened_by` (ADR 0012): who opened an explicit task, `agent` (`task_start`) or `user`
 * (`/task`). `task_done` may drop an agent's task that did nothing; a user's task is never
 * dropped. NULL for implicit tasks and rows from before this migration, which drop as before.
 */
const sql = `
ALTER TABLE tasks ADD COLUMN opened_by TEXT CHECK (opened_by IN ('agent', 'user'));
`;

export const taskOpener: Migration = { version: 10, name: "task-opener", sql };
