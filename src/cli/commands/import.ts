import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataPaths } from "../../config/paths.ts";
import { openDatabase } from "../../db/open.ts";
import { importHistory } from "../../import/index.ts";
import type { CliContext } from "../run.ts";

export const IMPORT_USAGE = [
  "Usage: hamness import [--claude-dir <dir>]... [--codex-dir <dir>]...",
  "",
  "Reads Claude Code and Codex history, read-only, into the hamness database.",
  "Stores counts, tokens, models, tools and timings, never message text.",
  "Re-running reads only what is new.",
  "",
  "Defaults (when no dir of that kind is given and the dir exists):",
  "  Claude Code  $CLAUDE_CONFIG_DIR or ~/.claude",
  "  Codex        $CODEX_HOME or ~/.codex",
].join("\n");

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

export async function importCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  let values: { "claude-dir"?: string[]; "codex-dir"?: string[]; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "claude-dir": { type: "string", multiple: true },
        "codex-dir": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(`hamness import: ${(e as Error).message}`);
    io.err(IMPORT_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(IMPORT_USAGE);
    return 0;
  }

  const home = env.HOME || homedir();
  const pick = (given: string[] | undefined, fallback: string) => {
    if (given?.length) return given.map((d) => resolve(d));
    return isDir(fallback) ? [fallback] : [];
  };
  const claudeDirs = pick(values["claude-dir"], env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const codexDirs = pick(values["codex-dir"], env.CODEX_HOME || join(home, ".codex"));

  const missing = [...claudeDirs, ...codexDirs].filter((d) => !isDir(d));
  if (missing.length > 0) {
    for (const d of missing) io.err(`hamness import: not a directory: ${d}`);
    return 2;
  }
  if (claudeDirs.length === 0 && codexDirs.length === 0) {
    io.out("No Claude Code or Codex history found. Point at it with --claude-dir or --codex-dir.");
    return 0;
  }

  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(dataPaths(dataDir).database);
  try {
    const r = await importHistory(db, { claudeDirs, codexDirs });
    const { files, added } = r;
    io.out(
      `Imported ${added.sessions} sessions, ${added.agents} agents, ${added.modelCalls} model calls, ${added.toolCalls} tool calls in ${(r.ms / 1000).toFixed(1)}s.`,
    );
    io.out(
      `Files: ${files.read} read, ${files.unchanged} unchanged, ${files.skipped} skipped (old format), ${files.failed} failed. ${r.lines} lines, ${r.badLines} unreadable.`,
    );
    return 0;
  } finally {
    db.close();
  }
}
