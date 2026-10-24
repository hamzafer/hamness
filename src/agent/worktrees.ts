import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HamnessDb } from "../db/open.ts";

/**
 * Git worktrees for subagents (ADR 0015). Each one is a new branch `hamness/<name>-<short id>`
 * from the parent's HEAD, checked out in a hamness-owned folder next to the repo:
 *
 *   <repo-parent>/<repo>.hamness-worktrees/<name>-<short id>
 *
 * Not in the data dir: the default safety rules deny every read and write there.
 */

export interface Worktree {
  path: string;
  branch: string;
}

export const WORKTREE_DIR_SUFFIX = ".hamness-worktrees";

export async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} exited with ${code}`);
  return out.trim();
}

/** A name safe for a branch and a folder: lowercase letters, digits and dashes. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "agent";
}

/** The last characters of a (UUIDv7) id: its random part. */
export const shortId = (id: string) => id.replace(/-/g, "").slice(-6);

/** Creates the worktree for a subagent started from `cwd`. Throws when `cwd` is not in a git repo. */
export async function createWorktree(
  cwd: string,
  name: string,
  agentId: string,
): Promise<Worktree> {
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`cannot make a worktree: ${cwd} is not in a git repository`);
  }
  const leaf = `${slug(name)}-${shortId(agentId)}`;
  const branch = `hamness/${leaf}`;
  const folder = join(dirname(root), `${basename(root)}${WORKTREE_DIR_SUFFIX}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, leaf);
  await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch };
}

/** A subagent worktree hamness made, as the database and git see it now. */
export interface SubagentWorktree {
  agentId: string;
  name: string;
  status: string;
  path: string;
  branch?: string;
  exists: boolean;
}

/** Every subagent worktree on record, newest first, with its branch when it still exists. */
export async function listSubagentWorktrees(db: HamnessDb): Promise<SubagentWorktree[]> {
  const rows = db.sqlite
    .query<{ id: string; name: string | null; status: string; worktree_path: string }, []>(
      `SELECT id, name, status, worktree_path FROM agents
       WHERE kind = 'subagent' AND worktree_path IS NOT NULL ORDER BY id DESC`,
    )
    .all();
  return Promise.all(
    rows.map(async (r) => {
      const exists = existsSync(r.worktree_path);
      const branch = exists
        ? await git(r.worktree_path, ["branch", "--show-current"]).catch(() => "")
        : "";
      return {
        agentId: r.id,
        name: r.name ?? shortId(r.id),
        status: r.status,
        path: r.worktree_path,
        ...(branch ? { branch } : {}),
        exists,
      };
    }),
  );
}

export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["done", "error", "aborted"]);

export const DIRTY = "has uncommitted changes";

export type PruneResult =
  | { path: string; removed: true }
  | { path: string; removed: false; reason: string };

/**
 * Removes a finished subagent's worktree folder. Its branch stays, so its commits are kept.
 * A worktree with uncommitted changes is kept: nothing hamness prunes loses work.
 */
export async function removeWorktree(path: string): Promise<PruneResult> {
  try {
    const dirty = await git(path, ["status", "--porcelain"]);
    if (dirty) return { path, removed: false, reason: DIRTY };
    const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await git(dirname(common), ["worktree", "remove", path]);
    return { path, removed: true };
  } catch (err) {
    return { path, removed: false, reason: (err as Error).message };
  }
}
