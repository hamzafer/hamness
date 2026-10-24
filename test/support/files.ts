import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Writes `{ "rel/path": "content" }` under `root`, making folders as needed. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** Every file under `root` with its content and mtime, to prove a folder was left alone. */
export function snapshotTree(root: string): Record<string, { content: string; mtimeMs: number }> {
  const out: Record<string, { content: string; mtimeMs: number }> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        out[relative(root, path)] = {
          content: readFileSync(path, "utf8"),
          mtimeMs: statSync(path).mtimeMs,
        };
    }
  };
  walk(root);
  return out;
}

/**
 * Makes `wt` a git worktree of `repo` the way `git worktree add` lays it out (a `.git` file
 * pointing at `<repo>/.git/worktrees/<name>`, whose `commondir` leads back), without running git.
 */
export function fakeWorktree(repo: string, wt: string): void {
  const name = wt.split("/").pop() as string;
  const gitdir = join(repo, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(gitdir, "gitdir"), `${join(wt, ".git")}\n`);
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
}
