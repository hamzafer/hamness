# 0021: Session commands reuse Pi's session machinery, and an open task follows `/new`

**Status:** accepted, 2026-10-25

The TUI gets Pi's interactive commands (`/new`, `/clear`, `/compact`, `/resume`, `/session`, `/thinking`, `/copy`, `/export`, `/name`, `/fork`) plus hamness's `/mode` and a list of skills and MCP servers. The daemon serves them as `/v1/sessions/:id/<action>` routes.

**Pi does the work.** Compaction is `AgentSession.compact`, thinking levels are Pi's (`getAvailableThinkingLevels`, `setThinkingLevel`), export is `exportToHtml` / `exportToJsonl`, `/copy` is `getLastAssistantText`, the name goes into Pi's file with `setSessionName`, and a fork is Pi's own: `SessionManager.createBranchedSession` at the entry before the user message (a fresh file with `parentSession` when it is the first message). hamness does not use Pi's `AgentSessionRuntime`, since the runner builds the `AgentSession` itself; a replacement starts a new runner and disposes the old one, the way the runtime's `newSession` / `switchSession` / `fork` do.

**One live session per cwd stays.** `/new`, `/resume` and `/fork` start the replacement first (a failure leaves the old session as it was), then end the old one: `session.replaced` goes to its clients, its subagents stop, its approvals are denied, its row gets `ended_at` and its main agent `done`. A resumed session is `running` again and becomes the one a daemon restart picks (the cwd's most recently updated session). `/new` and `/fork` keep the model, thinking level and session mode; `/resume` restores the stored ones.

**An open explicit task follows `/new` and `/fork`.** ADR 0012 keeps an explicit task open until it is closed. `/clear` mid-task is a context reset, not the end of the work, so the task moves to the new session (`tasks.session_id`) and its spend there still counts toward it. `/resume` leaves the current session's task on it (back when that session is resumed). There is never an open implicit task between turns, so none moves.

**A fork copies the transcript, not the spend.** The forked session gets copies of the main agent's messages and tool calls before the fork point, so it shows the history it continues. Model calls stay with the original session: the spend happened once. To find the fork point, user message rows store Pi's entry id (`messages.external_id`, migration 0007); older rows without one cannot be forked from.

**Mode per session.** `/mode ask|auto|yolo` sets a mode for that session only, kept in `sessions.safety_mode` and held by the safety service, which uses it over the config's mode. `yolo` emits `safety.mode` with a warning for clients to show as a banner; `session.mode` in snapshots says the same.

**Export** without a path writes under `<dataDir>/exports`; a relative path is in the session's cwd; an existing file is replaced only with `overwrite: true`. The export is unredacted, like Pi's own file, because the user asked for it.

**Compaction is spend.** The summary call is a stored model call (no message), counted toward the open task.
