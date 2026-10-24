import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { ChatStore } from "../agent/store.ts";
import { createWorktree } from "../agent/worktrees.ts";
import { dataPaths } from "../config/paths.ts";
import { openDatabase } from "../db/open.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let repo: string;
let paths: Record<string, string>;

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  return r.stdout.toString().trim();
}

beforeEach(async () => {
  home = tempHome();
  repo = join(home.dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  mkdirSync(join(home.dir, "data"));
  const db = openDatabase(dataPaths(join(home.dir, "data")).database);
  const chat = new ChatStore(db);
  const { sessionId, agentId } = chat.createSession(repo, "fake/m");
  paths = {};
  for (const [name, status] of [
    ["finished", "done"],
    ["busy", "running"],
    ["dirty", "error"],
  ] as const) {
    const id = chat.createSubagent({ sessionId, parentAgentId: agentId, name, model: "fake/m" });
    const wt = await createWorktree(repo, name, id);
    chat.setAgentWorktree(id, wt.path);
    chat.setAgentStatus(id, status);
    paths[name] = wt.path;
  }
  writeFileSync(join(paths.dirty as string, "wip.txt"), "unsaved\n");
  db.close();
});
afterEach(() => home.cleanup());

async function worktrees(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ["worktrees", ...args],
    { HAMNESS_HOME: join(home.dir, "data") },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("hamness worktrees", () => {
  test("lists subagent worktrees with their branch and status", async () => {
    const r = await worktrees();
    expect(r.code).toBe(0);
    for (const name of ["finished", "busy", "dirty"]) {
      expect(r.out).toMatch(new RegExp(`hamness/${name}-[0-9a-f]{6}`));
      expect(r.out).toContain(paths[name] as string);
    }
    expect(r.out).toMatch(/finished.*done/);
    expect(r.out).toMatch(/busy.*running/);
  });

  test("--prune removes finished clean worktrees, keeps running and dirty ones and all branches", async () => {
    const r = await worktrees("--prune");
    expect(r.code).toBe(0);
    expect(existsSync(paths.finished as string)).toBe(false);
    expect(existsSync(paths.busy as string)).toBe(true);
    expect(existsSync(paths.dirty as string)).toBe(true);
    expect(r.out).toContain("removed");
    expect(r.out + r.err).toContain("uncommitted");
    expect(git(repo, "branch", "--list", "hamness/finished-*")).toContain("hamness/finished-");

    const after = await worktrees();
    expect(after.out).not.toContain(paths.finished as string);
  });
});
