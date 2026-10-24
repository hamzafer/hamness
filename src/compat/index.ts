/**
 * Claude Code compatibility: reads CLAUDE.md, AGENTS.md, skills, MCP config and hooks in Claude
 * Code's formats. Never writes to them (ADR 0008).
 */
export type { ClaudeHooks, HookSession, PreToolOutcome } from "./hooks.ts";
export { createClaudeHooks, isProjectTrusted, trustProject } from "./hooks.ts";
export { claudeConfigDir } from "./paths.ts";
export { claudeToolName, toClaudeCall } from "./tools.ts";
