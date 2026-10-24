import { resolve } from "node:path";
import { hookSources, projectRoot } from "../../compat/hooks.ts";
import { claudeConfigDir, claudeManagedDir, managedDirOption } from "../../compat/paths.ts";
import type { CliContext } from "../run.ts";
import { trustCommand } from "./trust.ts";

export const HOOKS_USAGE = [
  "Usage: hamness hooks [dir]          List the Claude Code hooks hamness runs in dir",
  "       hamness hooks trust [dir]    Same as `hamness trust [dir]`",
  "",
  "hamness runs command hooks from Claude Code's settings files: ~/.claude/settings.json",
  "(or $CLAUDE_CONFIG_DIR) always, and the project's .claude/settings.json and",
  "settings.local.json as you trusted them (`hamness trust`). It never edits those files.",
].join("\n");

export async function hooksCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  const [first, second] = args;
  if (first === "-h" || first === "--help") {
    io.out(HOOKS_USAGE);
    return 0;
  }
  const claudeDir = claudeConfigDir(env);
  if (first === "trust") {
    return trustCommand({ args: second ? [second] : [], env, dataDir, io });
  }
  const cwd = resolve(first ?? process.cwd());
  const sources = hookSources(
    { claudeDir, dataDir, ...managedDirOption(claudeManagedDir({ env })) },
    cwd,
  );
  if (sources.length === 0) {
    io.out("No Claude Code hooks found.");
    return 0;
  }
  for (const src of sources) {
    const state = src.runs
      ? "runs"
      : src.hooks.some((h) => !h.trusted)
        ? `not trusted (review, then run \`hamness trust ${projectRoot(cwd)}\`)`
        : "off (disableAllHooks)";
    io.out(`${src.file}  [${src.scope}, ${state}]`);
    for (const h of src.hooks) {
      const note = h.trusted ? "" : "  (not trusted)";
      io.out(`  ${h.event}${h.matcher ? ` ${h.matcher}` : ""}: ${h.command}${note}`);
    }
  }
  return 0;
}
