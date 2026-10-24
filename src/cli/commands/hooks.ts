import { resolve } from "node:path";
import { hookSources, isProjectTrusted, projectRoot, trustProject } from "../../compat/hooks.ts";
import { claudeConfigDir, claudeManagedDir, managedDirOption } from "../../compat/paths.ts";
import type { CliContext } from "../run.ts";

export const HOOKS_USAGE = [
  "Usage: hamness hooks [dir]          List the Claude Code hooks hamness runs in dir",
  "       hamness hooks trust [dir]    Let the repo holding dir run its project hooks",
  "",
  "hamness runs command hooks from Claude Code's settings files: ~/.claude/settings.json",
  "(or $CLAUDE_CONFIG_DIR) always, and the project's .claude/settings.json and",
  "settings.local.json once you trust the repo. It never edits those files.",
].join("\n");

export async function hooksCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  const [first, second] = args;
  if (first === "-h" || first === "--help") {
    io.out(HOOKS_USAGE);
    return 0;
  }
  const claudeDir = claudeConfigDir(env);
  if (first === "trust") {
    const root = trustProject(dataDir, resolve(second ?? process.cwd()));
    io.out(`Trusted ${root}: its Claude Code hooks run from the next event on.`);
    return 0;
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
      : src.scope === "project" && !isProjectTrusted(dataDir, cwd)
        ? `not trusted (run \`hamness hooks trust ${projectRoot(cwd)}\`)`
        : "off (disableAllHooks)";
    io.out(`${src.file}  [${src.scope}, ${state}]`);
    for (const h of src.hooks) {
      io.out(`  ${h.event}${h.matcher ? ` ${h.matcher}` : ""}: ${h.command}`);
    }
  }
  return 0;
}
