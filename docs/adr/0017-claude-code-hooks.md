# 0017: Claude Code hooks run as Claude Code runs them, behind per-repo trust

**Status:** accepted, 2026-10-24

hamness runs `command` hooks from Claude Code's settings files for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop, with Claude Code's matcher, JSON stdin/stdout, exit code 2 and default timeouts (600 s, 30 s for UserPromptSubmit). Hooks see Claude Code's tool names and input keys (`Bash`, `Read`, `file_path`, ...), translated from Pi's in one module (`src/compat/tools.ts`).

- A PreToolUse hook runs before the rules. Its deny is final; its allow skips the ask but never overrides a rule deny or ask; every hook verdict is a decision with source `hook`.
- A Stop block continues the turn with the reason, at most 8 times in a row (Claude Code's cap); a UserPromptSubmit block keeps the prompt from the model and tells the user.
- User hooks (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR`) always run. Project hooks run only after `hamness hooks trust`, kept per repo in hamness's own config, since a cloned repo's hooks are someone else's code.
- A hook that crashes or times out decides nothing and is logged; the session never waits past the timeout.
- Not yet: `http`, `prompt`, `agent` and `mcp_tool` hooks, `updatedInput`, other events.
