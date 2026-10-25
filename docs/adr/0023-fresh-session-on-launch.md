# 0023: A launch opens a fresh session; continuing is opt-in

**Status:** accepted, 2026-10-25. Amends ADR 0021's "one live session per cwd".

Plain `hamness` used to attach to the folder's latest session, and that session's model came with it. Claude Code opens a fresh chat on every launch and makes going back opt-in; hamness now does the same.

**The launch picks its session.** `POST /v1/sessions` takes `start: "new"`, `start: "continue"` or a `sessionId`. The TUI always says which:
- `hamness`: `new`, a fresh session with the configured default model (`HAMNESS_MODEL` or the config), never a previous session's model, thinking level, mode or name.
- `hamness -c` / `--continue`: `continue`, the folder's latest session (the one prompted last, or the one `/new`, `/resume` or `/fork` made current), live or resumed from SQLite and Pi's file, with its own model. With none, a fresh one.
- `hamness -r <id>` / `--resume <id>`: that session, even one `/new` left. An unknown id is a 404, another folder's a 400.
- `hamness -r` with no id: a fresh session with the `/resume` picker open at startup. Esc keeps the fresh chat.

A body with neither field means `continue`, so API clients that attach as before keep their behavior. A daemon restart changes nothing here: a fresh launch never looks at the stored sessions, and `continue` reads the latest one from SQLite, not from what the daemon happened to have live.

**An open task is not dropped.** An open explicit task stays on the session that holds it (ADR 0012 keeps it open until it is closed). A fresh launch in a folder where another session holds one returns it as `openTask` in the snapshot, and the TUI shows one quiet line: "An open task from your last session: <goal>. /resume to continue it." The task does not move: moving it would charge the new chat's spend to work it never saw. `/new` still carries an open task along (ADR 0021): that is the user resetting context mid-task, not starting elsewhere.

**Several live sessions per cwd.** A second window opened in a folder gets its own fresh session, as a second Claude Code terminal would; the first window keeps its own. `-c` in the second window joins the latest one instead, and both windows then show it. `/new`, `/resume` and `/fork` still replace only the session they are sent for, and only that session's windows follow (`session.replaced`). The TUI follows to the session the event names (`newSessionId`), never to "the cwd's latest", since that may be another window's. `/resume` of a session that is live in another window switches to it (its windows and this one share it); it never starts a second agent for one id. `GET /v1/sessions?cwd=&current=<id>` marks the asking window's session as current.

**Idle sessions sleep.** One live agent per launch would keep a Pi session and its MCP servers per `hamness` run until the daemon stops. So a fresh launch puts the folder's idle sessions to sleep: not busy, no compaction or replacement running, no approval waiting, no subagent out. Sleeping is a daemon stop for one session: the runner is disposed, the rows and Pi's file stay, nothing is ended. Any request to a sleeping session (`/v1/sessions/:id/...`) wakes it first: resumed from SQLite and Pi's file under the same ids, its event numbers going on from where they were. So a window left open on a session that slept just works: its next prompt pays one resume (Pi's file reloads, SessionStart hooks run with `resume`, MCP servers start again). A session that slept before its first prompt has no rows; the daemon keeps its ids, model, thinking level, mode and name in memory (the last 200) and wakes it as a fresh session under the same ids. A session `/new`, `/resume` or `/fork` left does not wake on a request; only `-r <id>` or `/resume` bring it back.

**Coming back to the same session.** A client that needs its session again asks for it by id (`sessionId`), not by folder, and gets the same session, awake or woken, even after a daemon restart, rather than whichever is newest.

**Rejected.** A fresh launch that replaces the folder's live session (one live session per cwd, as before): it would flip a window already open there to the new empty chat. Waking only on prompt: every route a stale window can call (`/model`, `/status`, `/mode`) would 404 instead.
