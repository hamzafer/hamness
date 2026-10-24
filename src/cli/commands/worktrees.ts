import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DIRTY,
  FINISHED_STATUSES,
  listSubagentWorktrees,
  removeWorktree,
} from "../../agent/worktrees.ts";
import { dataPaths } from "../../config/paths.ts";
import { openDatabase } from "../../db/open.ts";
import type { CliContext } from "../run.ts";

export const WORKTREES_USAGE = [
  "Usage: hamness worktrees [--prune] [--json]",
  "",
  "Lists the git worktrees subagents ran in (<repo>.hamness-worktrees/ next to each repo):",
  "name, status, branch and path.",
  "",
  "  --prune  Remove the worktrees of finished subagents. Their branches stay, and a worktree",
  "           with uncommitted changes is kept.",
  "  --json   Print the rows as JSON",
].join("\n");

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export async function worktreesCommand({ args, dataDir, io }: CliContext): Promise<number> {
  let values: { prune?: boolean; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        prune: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(`hamness worktrees: ${(e as Error).message}`);
    io.err(WORKTREES_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(WORKTREES_USAGE);
    return 0;
  }
  const dbPath = dataPaths(dataDir).database;
  if (!existsSync(dbPath)) {
    io.out("No subagent worktrees.");
    return 0;
  }
  const db = openDatabase(dbPath);
  try {
    const all = (await listSubagentWorktrees(db)).filter((w) => w.exists);
    if (values.prune) {
      let failed = 0;
      for (const w of all.filter((w) => FINISHED_STATUSES.has(w.status))) {
        const r = await removeWorktree(w.path);
        if (r.removed) io.out(`removed ${w.path} (branch ${w.branch ?? "?"} kept)`);
        else if (r.reason === DIRTY) io.out(`kept ${w.path}: it ${DIRTY}`);
        else {
          failed += 1;
          io.err(`could not remove ${w.path}: ${r.reason}`);
        }
      }
      const running = all.filter((w) => !FINISHED_STATUSES.has(w.status)).length;
      if (running) io.out(`${running} still running, left alone.`);
      return failed ? 1 : 0;
    }
    if (values.json) {
      io.out(JSON.stringify(all, null, 2));
      return 0;
    }
    if (all.length === 0) {
      io.out("No subagent worktrees.");
      return 0;
    }
    const nameWidth = Math.max(4, ...all.map((w) => w.name.length));
    const branchWidth = Math.max(6, ...all.map((w) => (w.branch ?? "").length));
    io.out(`${pad("NAME", nameWidth)}  ${pad("STATUS", 8)}  ${pad("BRANCH", branchWidth)}  PATH`);
    for (const w of all) {
      io.out(
        `${pad(w.name, nameWidth)}  ${pad(w.status, 8)}  ${pad(w.branch ?? "", branchWidth)}  ${w.path}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
