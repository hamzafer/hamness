# 0016: What hamness trusts from Claude Code's setup

**Status:** accepted, 2026-10-24; trust and approvals refined by ADR 0020 (`hamness trust`, stored under `trust.projects`)

ADR 0008 says hamness reads Claude Code's files as they are. Some of those files come with a repo, not from the user, and some of them run code. This ADR fixes what loads without asking.

- **MCP servers run code.** User-scope and local-scope servers (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`) are the user's own config and start. A repo's `.mcp.json` servers start only after `hamness compat approve` in that repo, like Claude Code's approval prompt. The approval is stored per repo root in hamness's user config (`<data dir>/config.json`, `compat.mcpApprovals`), never in the repo (a repo can't approve itself) and never in Claude Code's files. It keys on a hash of the server's definition, so an edited entry asks again. Approvals given in Claude Code are not reused; Claude Code's `disabledMcpjsonServers` and `disabledMcpServers` are, since they only turn servers off.
- **Expansion stays Claude Code's.** `${VAR}` and `${VAR:-default}` expand once, as Claude Code does; the result is escaped before Pi's MCP client sees it, so Pi's own `$NAME` and `!command` value syntax never applies to a Claude Code config.
- **Instruction files and skills are text.** They load without asking. A repo instruction file can't `@import` a file outside the repo (Claude Code asks; hamness skips it and `hamness compat` says so), so a cloned repo can't pull `~/.ssh` into the prompt. User files can import anything.
- **Skills load through a `skill` tool,** not Pi's "read the SKILL.md" convention, so a body arrives with Claude Code's placeholders filled in and the safety rules can allow it as one tool. Skill fields that would change permissions or the model (`allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, ...) are read but not honored, and a skill's `` !`command` `` lines are never run.
- **Pi's MCP client is reused** with `direct` exposure, so the model sees `mcp__<server>__<tool>` and every call passes the safety guard. Its `/mcp` config edits are disabled, and its OAuth tokens and log live under `<data dir>/pi`.

Not done yet: folders below the cwd and path-scoped rules (Claude Code loads them lazily), legacy `.claude/commands`, plugin skills and servers, SSE and WebSocket servers, `headersHelper`.
