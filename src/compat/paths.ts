import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../config/paths.ts";

/**
 * Where Claude Code keeps its files. Shared by every reader of Claude Code's setup
 * (instructions, skills, MCP, hooks), so they all agree on `CLAUDE_CONFIG_DIR`.
 * hamness only ever reads these paths (ADR 0008).
 */

export interface ClaudeEnv {
  env: Env;
  /** The user's home. Default: `$HOME`, else the OS home. */
  home?: string;
  platform?: NodeJS.Platform;
  /** The managed (organization) policy folder. Default: the platform's; tests point it at a fixture. */
  managedDir?: string;
}

export const homeOf = (c: ClaudeEnv): string => c.home ?? c.env.HOME ?? homedir();

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. hamness only reads it. */
export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR;
  return override ? resolve(override) : join(home, ".claude");
}

/** `claudeConfigDir` for a `ClaudeEnv`. */
export const claudeDirOf = (c: ClaudeEnv): string => claudeConfigDir(c.env, homeOf(c));

/**
 * Claude Code's global state file, which holds user and local-scope MCP servers:
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set, else `~/.claude.json`.
 */
export function claudeGlobalConfigFile(c: ClaudeEnv): string {
  const override = c.env.CLAUDE_CONFIG_DIR;
  return override ? join(resolve(override), ".claude.json") : join(homeOf(c), ".claude.json");
}

/** The managed policy folder (CLAUDE.md, managed-settings.json, managed-mcp.json). */
export function claudeManagedDir(c: ClaudeEnv): string | undefined {
  if (c.managedDir) return c.managedDir;
  const platform = c.platform ?? process.platform;
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "linux") return "/etc/claude-code";
  return undefined;
}

/** Settings files in Claude Code's order, lowest precedence first. */
export function claudeSettingsFiles(c: ClaudeEnv, cwd: string) {
  const managed = claudeManagedDir(c);
  return {
    user: join(claudeDirOf(c), "settings.json"),
    project: join(cwd, ".claude", "settings.json"),
    local: join(cwd, ".claude", "settings.local.json"),
    ...(managed ? { managed: join(managed, "managed-settings.json") } : {}),
  };
}

/** The nearest folder at or above `cwd` with a `.git` entry (a repo or worktree root). */
export function repoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** `cwd` and every folder above it, from the filesystem root down to `cwd`. */
export function ancestorsDown(cwd: string): string[] {
  const out: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    out.unshift(dir);
    const up = dirname(dir);
    if (up === dir) return out;
    dir = up;
  }
}
