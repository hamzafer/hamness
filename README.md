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
```

Data lives in `~/Library/Application Support/hamness` on macOS and `$XDG_DATA_HOME/hamness` (default `~/.local/share/hamness`) on Linux. Set `HAMNESS_HOME` to use another dir and `HAMNESS_PORT` to change the API port (default 7357).

Chat uses Claude (`anthropic/claude-opus-5-5`; `HAMNESS_MODEL=provider/id` sets the default) with an API key from `ANTHROPIC_API_KEY` or `hamness keys set anthropic` (stored in `keys.json` in the data dir, mode 0600; env vars win). Other providers work the same way (`OPENAI_API_KEY`, `hamness keys set openai`), and `hamness login openai` signs in with a ChatGPT plan. Claude subscriptions are not used: Anthropic is API key only (ADR 0011). In the TUI, `/model` opens a picker and `/model provider/id` switches directly; each model call records its own model and cost. Prices live in `src/models/price-data.ts`, with their sources and the date they were checked.

Sessions keep running when the TUI closes; reopening it in the same dir reattaches. After a daemon restart, the dir's last session resumes with its transcript and context (from Pi's session file in `<data dir>/pi/sessions`).

### TUI keys

| Key | Does |
|---|---|
| Enter | send the prompt |
| Esc | stop the running prompt |
| Ctrl+R | open the side rail full screen, and back |
| Ctrl+C | leave the TUI (the session keeps running) |

The side rail on the right shows one row per agent (status, current tool and file, elapsed time, tokens, cost), the context gauge and the session cost.

## License

MIT
