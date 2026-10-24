# 0012: Task outcome rules, the implicit turn task, and the gate in the database

**Status:** accepted, 2026-10-24

ADR 0005 sets the gate; this records the rules around it that the spec leaves open.

**Opening.** The agent opens a task with `task_start(goal)`, the user with `/task <goal>`. When a user turn starts with no open task, hamness opens an **implicit task** named after the prompt. A `task_start` or `/task` during that turn **promotes** it (same id, now explicit with the new goal), so the turn's spend so far counts toward the task. Only one task is open per session: a second `task_start` is refused. An explicit task stays open across turns, and across a daemon restart, until it is closed.

**Closing.**
- `task_done(summary)`: `verified` if the proof gate passes (ADR 0019: the latest evidence passed, after the last file change, and not only weak file evidence), else `unverified`.
- `/override [reason]` (user only, never an agent tool): the open task, or the last task if it is `unverified`, becomes `overridden`. A verified, abandoned or overridden task cannot be overridden.
- `/abandon [reason]` (user only): the open task becomes `abandoned`.
- An implicit task still open at turn end: `verified` when the gate passes; `unverified` with evidence that failed (not `error`, which checked nothing), or with `edit` / `write` calls or subagents (work that went unproven); otherwise it is **dropped** (with any `error` evidence): the row is deleted and its messages, model calls and tool calls keep no `task_id`. A chat turn is no task, so it doesn't drag down the verified rate, but its spend still counts in cost per verified task. `bash` alone doesn't count as an edit, since most commands only read.

**Accounting.** Rows the session stores carry the current task's id: the open task, or the one closed earlier in the same turn, so the agent's wrap-up after `task_done` counts toward it. A task's cost and tokens are the sum of its `model_calls`; its time is `ended_at - started_at`.

**Evidence.** `prove` validates the claim strictly (any result-like or unknown field is refused), stores it as a pending claim, runs the checker and writes its result; `src/tasks/proof.ts` is the only code that writes `evidence.status`. A command re-run passes the session's safety check as `prove_command`: bash's deny and ask rules, and the proof command list instead of bash's allow rules (ADR 0019), so `prove` cannot run what `bash` may not, and runs unasked only what counts as proof. `error` (blocked, aborted, `gh` missing) is not a pass. Migration 0006 holds the gate in SQLite too: evidence starts pending, gets one complete result and is then final; a task becomes `verified` only with passed evidence; a closed outcome is final except `unverified` to `overridden`.

**Migrations** may now have gaps in their numbers (tickets claim numbers up front and land in any order); every migration not yet recorded runs, in version order.

Consequences: an agent that never calls `prove` and never edits files leaves no tasks at all, which shows as spend with no verified tasks rather than as a high rate. An agent can still reach the database file through `bash`; the triggers stop a plain `UPDATE`, the safety rules deny edits under the data dir, and a `sqlite3` command is not on the allow list, so it asks.
