# hamness v1: design

**Status:** approved 2026-10-24 (from a design interview; decisions recorded in `docs/adr/`).
**Working name:** hamness. The public name is picked before the first release.

## The angle: glass box + proof

Every coding harness can run an agent. hamness is the one you can **see into** and **trust**:

1. **Glass box.** You always see what every agent, shell and review is doing, what it costs, and which file it is on.
2. **Proof.** Nothing counts as done without evidence that hamness checked itself.
3. **Outcomes.** Every token and dollar is tied to a **Task**, so you can say "this PR cost $3.10 and 41 minutes, verified".

Why: the leading harnesses (Claude Code, Codex, opencode, OpenClaw, Hermes, T3 Code) show tokens or dollars, but none ties cost to verified outcomes, and none makes "done" mean "proven". Heavy users build their own status lines, agent radars and usage meters to work around this.

## Users and the v1 bar

- **Public from day one** (MIT), but v1 is shaped by one heavy daily user.
- **v1 is done when** that user does one full day of real work in hamness instead of Claude Code, and the dashboard shows that day.

## Architecture

```
            +-------------------------------+
  TUI  ---->|                               |
 (OpenTUI)  |   hamness daemon (Bun, TS)    |----> model providers
            |                               |      (Anthropic, OpenAI, ...)
  web  ---->|  HTTP + WebSocket event API   |
 dashboard  |  Pi agent loop (library)      |----> tools: read/edit/bash,
            |  Tasks, proof, safety, stats  |      MCP servers, skills
            |  SQLite (one file)            |
            +-------------------------------+
```

- **Daemon** (`hamness daemon`): a long-running Bun process. It owns sessions, agents, the database and the event stream. Clients attach and detach freely, so sessions survive closing a window.
- **Clients** talk to the daemon over a local HTTP + WebSocket API (localhost only, a token file for auth). v1 clients: the **TUI** and the **web dashboard**. The TUI starts the daemon if it is not running.
- **Agent loop:** Pi, used as a library. hamness wraps Pi's tools with its safety layer and listens to Pi's events for the glass box and stats. hamness does not write its own model plumbing.
- **Language and runtime:** TypeScript on Bun. One repo, workspaces only if needed.

## Core concepts

See `GLOSSARY.md` for the terms. The main ones:

- **Session:** a conversation with a main agent in one working directory.
- **Agent:** a running Pi loop. The main agent can start **subagents**, in the background, each optionally in its own git **worktree**.
- **Task:** the unit of work and the unit of accounting. A task has a goal, the agents that worked on it, cost, tokens, wall time, **evidence** and an **outcome** (`open`, `verified`, `unverified`, `overridden`, `abandoned`). Tasks can link to a git branch, commit or PR.
- **Evidence:** a claim the agent attaches to a task with the `prove` tool, which hamness checks on its own.
- **Decision:** a safety verdict on one tool call (`allow`, `ask`, `deny`) with its source (rule, judge, user) and reason.

## Feature set

### 1. Chat in the terminal (TUI)
- Chat pane on the left, **side rail** on the right, always on. One key opens the rail full screen.
- Streaming replies, tool calls shown compactly, an input box with multiline support, slash commands.
- Approval prompts appear inline when the safety layer says `ask`.

### 2. The side rail (glass box)
- One row per agent, background shell and check: status, current tool, current file, elapsed time, tokens, cost. (Background shells wait for Pi to have them; ADR 0019.)
- The current Task at the top: goal, outcome state, evidence count.
- Context gauge (how full the context window is) and session cost.
- Live: driven by the daemon's event stream.

### 3. Tasks and the proof gate
- The agent opens a task with `task_start(goal)` and closes it with `task_done(summary)`. The user can also open one with `/task <goal>`. Messages without a task go into an implicit task per user turn.
- **`prove` tool:** the agent attaches evidence: `{ kind, ... }` where kind is
  - `command`: a command that should succeed (tests, build, lint). hamness **re-runs it itself** and stores exit code, duration and the output tail.
  - `ci`: a PR or commit. hamness checks CI status itself through `gh`.
  - `file`: an artifact such as a screenshot. hamness checks it exists, is non-empty and was written during the task, and stores its hash.
  - `url`: a live check. hamness fetches it and stores the status code.
- **Hard gate:** `task_done` only yields `verified` when evidence passed hamness's own check (ADR 0019: the latest evidence, after the last file change, not only weak file evidence, and commands on the proof command list or approved by the user). Otherwise the task closes as `unverified`, shown in red in the TUI and dashboard. Only the user can mark it `overridden` (`/override`).
- Agents cannot write evidence results directly; only hamness's checkers can.

### 4. Safety: rules, judge, audit log
- **Rules** (allow / ask / deny, opencode style): per tool, with glob patterns on commands and paths, last match wins. Sensible defaults (reads allowed, writes inside the workspace allowed, `rm -rf`, force push, reading `.env` and secrets ask or deny).
- **Judge:** a call the rules don't decide goes to a small model (default: the ChatGPT plan's `gpt-5.6-luna` at low thinking, ADR 0023; Claude Haiku on an API key the user chose) that answers with a strict JSON verdict (`allow` / `ask` with a reason and category). Any error, timeout or doubt means `ask`. A daily cap applies: 500 calls on the plan (calls cost $0), $1 on an API key; over it, everything undecided asks.
- **Back-off:** after 3 judge `ask`s in a row in a session, the judge pauses for that session and everything undecided asks.
- **Audit log:** every decision is stored with tool, arguments (secrets redacted), source, reason, latency and cost. `hamness audit` and the dashboard show why each action ran.
- **Modes:** `ask` (rules only, everything undecided asks), `auto` (rules + judge, the default), `yolo` (no questions and no judge, loud banner; deny rules, default and user, still apply, ADR 0022). OS sandboxing is **out of scope for v1**.

### 5. Models and auth
- Multi-provider through Pi. **No dependence on pay-per-token APIs (ADR 0023):** the default is the user's **ChatGPT plan login** (`hamness login openai`, Pi's `openai-codex` provider). Its model is picked by plan tier (`gpt-6.1-sol` on Plus/Pro/Team/Business, `gpt-5.6-terra` on Go) for the main agent and subagents; the judge uses `gpt-5.6-luna`.
- Default order: `HAMNESS_MODEL`, then `defaultModel` in the user config, then the ChatGPT plan, then a clear "not set up" state. An API key alone never makes a model the default.
- API keys stay an optional extra (environment variables or a key file with 0600 permissions; macOS Keychain later), used only by a model the user picks. Claude subscriptions are not used outside Anthropic's apps, so Claude is reached only through an optional API key (ADR 0011).
- The billing kind shows next to the model everywhere (header, `/status`, `/model`, doctor): "plan" vs "API (pay per token, from <env var>)". Plan calls record their tokens and cost $0 ("$0 (plan)").
- Model per session and per subagent, `/model` to switch (plan models first).

### 6. Claude Code compatibility
- Reads **CLAUDE.md and AGENTS.md** (user level and project level, nearest wins) into the system prompt.
- Loads **skills** (SKILL.md with frontmatter) from Claude Code's and hamness's skill folders; the description goes in the prompt, the body loads on demand.
- Loads **MCP servers** from `.mcp.json` and the user's Claude Code config, as tools.
- Runs **hooks** from Claude Code settings for the events that map cleanly (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart), with the same JSON stdin/stdout contract. A hook deny is a `deny` decision in the audit log.
- Never writes to Claude Code's files.

### 7. Stats, telemetry and the dashboard
- Everything lands in **one SQLite file** (`bun:sqlite`) under hamness's data dir: sessions, agents, messages, tool calls, decisions, tasks, evidence, token usage and cost per model call.
- **Local only.** No telemetry leaves the machine. The schema has stable ids and `updated_at` columns so an optional sync to self-hosted Postgres (Supabase first) can be added later without migration pain. **Sync is out of scope for v1.**
- **`hamness stats`** prints a terminal summary: today, 7 days, 30 days: tasks verified vs unverified, cost per verified task, top models, judge decisions.
- **Web dashboard** served by the daemon on localhost: KPI tiles (cost, tasks, verified rate, cost per verified task, time), one hero chart over time with range toggles (24h, 7d, 30d, 90d), a task table (goal, cost, time, outcome, evidence), a decisions view, and a filter for source (hamness, Claude Code, Codex). Light and dark.
- **Import** (read-only): `hamness import` reads Claude Code session JSONL (all config dirs the user points it at, e.g. `~/.claude` and a second account dir) and Codex session files into the same tables, marked with their source, so the dashboard shows months of history and compares hamness against them. Import never writes to those folders and stores no message text by default (counts, tokens, models, tools, timings only).

## Out of scope for v1
OS sandbox, cloud sync, the public name and branding, Windows support, an IDE extension, a phone client, a mod or plugin system beyond Claude Code compatibility.

## Quality bar
- Test-first for every ticket (`bun test`). The proof checkers, safety rules, judge parsing, import parsers and stats queries have unit tests; the daemon API has integration tests; the TUI has a smoke test that renders the layout headless.
- CI on GitHub Actions: typecheck, lint, tests on macOS and Linux. Actions pinned to commit SHAs.
- No personal data in the repo: tests use synthetic fixtures, never real transcripts.

## Open questions (decided later)
- The public name.
- Sync protocol details.
- Whether the judge prompt should learn from the user's past `ask` answers.
