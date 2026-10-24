import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Env } from "../config/paths.ts";

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. hamness only reads it. */
export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR;
  return override ? resolve(override) : join(home, ".claude");
}
