# hamness

An AI coding harness you can see into and trust.

- **Glass box:** a live side rail shows every agent, shell and check, with what it costs and which file it's on.
- **Proof:** nothing is done until hamness has checked the evidence itself (tests re-run, CI read, screenshots checked).
- **Outcomes:** every dollar is tied to a task, so you know what a verified change cost.

Runs on Bun. Multi-model (Claude by default). Reads your Claude Code setup (CLAUDE.md, AGENTS.md, skills, MCP, hooks) as it is.

**Status:** early, pre-release. See the [v1 design](docs/superpowers/specs/2026-10-24-hamness-v1-design.md).

## Development

Needs [Bun](https://bun.sh) 1.4.4 or newer.

```sh
bun install
bun test            # unit + integration tests
bun run typecheck   # strict TypeScript
bun run lint        # Biome (bun run format to fix)
bun src/cli/main.ts          # chat TUI for this dir (starts the daemon if needed)
bun src/cli/main.ts daemon   # run the daemon in the foreground
bun src/cli/main.ts status   # is it running?
bun src/cli/main.ts import   # read Claude Code and Codex history (read-only)
bun src/cli/main.ts models   # models you can switch to, with prices (--all: whole catalog)
bun src/cli/main.ts keys set anthropic   # store an API key (hidden prompt, mode 0600)
bun src/cli/main.ts login openai         # sign in with a ChatGPT plan (through Pi)
bun src/cli/main.ts audit    # recent safety decisions and why (--session, --limit, --json)
bun src/cli/main.ts stats    # sessions, tasks, cost, models and decisions (--range, --source, --json)
bun src/cli/main.ts dashboard   # open the web dashboard (--no-open prints the link)
```

Data lives in `~/Library/Application Support/hamness` on macOS and `$XDG_DATA_HOME/hamness` (default `~/.local/share/hamness`) on Linux. Set `HAMNESS_HOME` to use another dir and `HAMNESS_PORT` to change the API port (default 7357).

Chat uses Claude (`anthropic/claude-opus-5-5`; `HAMNESS_MODEL=provider/id` sets the default) with an API key from `ANTHROPIC_API_KEY` or `hamness keys set anthropic` (stored in `keys.json` in the data dir, mode 0600; env vars win). Other providers work the same way (`OPENAI_API_KEY`, `hamness keys set openai`), and `hamness login openai` signs in with a ChatGPT plan. Claude subscriptions are not used: Anthropic is API key only (ADR 0011). In the TUI, `/model` opens a picker and `/model provider/id` switches directly; each model call records its own model and cost. Prices live in `src/models/price-data.ts`, with their sources and the date they were checked.

Sessions keep running when the TUI closes; reopening it in the same dir reattaches. After a daemon restart, the dir's last session resumes with its transcript and context (from Pi's session file in `<data dir>/pi/sessions`).

### Safety

Every tool call passes allow / ask / deny rules before it runs (ADR 0006). Defaults: reads are allowed except `.env` files and secrets (`~/.ssh`, `~/.aws`, keys), writes inside the session's dir are allowed, bash asks except for a small read-only list (`ls`, `cat`, `grep`, `git status`, `git diff`, `git log`, ...), `rm -rf` and force pushes ask, `sudo` and `curl | sh` are denied. Compound commands (`&&`, `;`, `|`, subshells, `$(...)`) are checked part by part, and the strictest part wins.

Add rules under `safety` in `<data dir>/config.json` (yours) or `.hamness/config.json` at the repo root (the project's). Patterns are globs, the last matching rule wins, and a project rule can allow what nothing else decides but never loosens an `ask` or `deny`:

```json
{
  "safety": {
    "mode": "auto",
    "approvalTimeoutSec": 900,
    "permission": {
      "bash": { "npm test *": "allow", "npm publish *": "deny" },
      "{write,edit}": { "$CWD/dist/**": "deny" },
      "mcp__github__*": "ask"
    }
  }
}
```

Modes (user config only): `ask` asks you about anything no rule decides, `auto` (the default) asks a judge model first, `yolo` allows everything and says so in a red banner.

The judge (auto mode) is Claude Haiku 5.5 by default, keyed like chat (`ANTHROPIC_API_KEY` or the key file). It sees the call (secrets redacted) as untrusted data and answers a strict JSON verdict: `allow`, or `ask` with a reason and a risk category (`src/safety/judge/categories.ts`). An error, a timeout (8 s), a refusal or an answer that does not parse means you are asked. Its spend is capped per local day (default $1, from the stored judge decisions); over the cap, undecided calls ask you. After 3 judge asks in a row it pauses for that session until the daemon restarts or you type `/judge resume`. With no API key it is off and undecided calls ask you. The TUI header shows its state (`judge on`, `paused`, `over budget`, `off: no key`). Settings, user config only:

```json
{ "safety": { "judge": { "model": "claude-haiku-5-5", "dailyBudgetUsd": 1, "timeoutSec": 8 } } }
```
 When a call asks, the TUI shows it above the input: `y` allows once, `a` allows always (saves the suggested pattern to the project config), `n` or Esc denies. With no answer it is denied after the timeout. Every decision is stored with its source and reason; `hamness audit` lists them.

### TUI keys

| Key | Does |
|---|---|
| Enter | send the prompt |
| Esc | stop the running prompt (deny, when an approval shows) |
| y / a / n | answer an approval: allow once, allow always, deny |
| Ctrl+R | open the side rail full screen, and back |
| Ctrl+C | leave the TUI (the session keeps running) |

The side rail on the right shows the current task (goal, outcome, passing / checked evidence; unverified in red), one row per agent (status, current tool and file, elapsed time, tokens, cost), the context gauge and the session cost.

### Tasks and proof

Work happens in tasks. The agent opens one with `task_start`, attaches evidence with `prove` and closes it with `task_done`; you can open one with `/task <goal>`. hamness checks the evidence itself: it re-runs a command (through the same safety rules as `bash`), checks a file was written during the task, fetches a URL, or reads CI through `gh`. A task is `verified` only when at least one piece passed; otherwise it is `unverified`. Only you can accept it anyway with `/override [reason]`, or drop the open task with `/abandon [reason]`. A turn with no task open gets its own task, which is dropped at the end if it had no evidence and no file edits. Cost, tokens and time roll up to the task (ADRs 0004, 0005, 0012).

### Dashboard

`hamness dashboard` opens the web dashboard the daemon serves on `127.0.0.1` (starting the daemon if needed; `--no-open` prints the link instead). It shows cost, tasks, verified rate, cost per verified task and active time for the last 24 hours, 7, 30 or 90 days, one chart over time (cost, tokens or tasks, with a table view), the task list with each task's outcome and evidence, and the safety decisions. Filter by source: hamness, Claude Code or Codex (imported history has no tasks, and its cost is estimated from token counts). Light and dark follow the system; the toggle overrides it.

![The hamness dashboard on sample data: KPI tiles and cost per day](images/dashboard.png)

The link carries the daemon's token after `#`, which the browser keeps to itself; the page stores it for that tab only (ADR 0018).

## License

MIT
