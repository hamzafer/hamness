import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { projectKey, projectRoot } from "../compat/paths.ts";
import {
  addTrusted,
  allowItem,
  isTrusted,
  proofItem,
  readTrust,
  revokeTrust,
  setTrusted,
} from "./index.ts";

let home: ReturnType<typeof tempHome>;
let root: string;
let dataDir: string;
beforeEach(() => {
  home = tempHome();
  root = realpathSync(home.dir);
  dataDir = join(root, "data");
});
afterEach(() => home.cleanup());

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

describe("projectRoot and projectKey", () => {
  test("a subfolder of a repo maps to the repo root; outside a repo, the folder itself", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(projectRoot(join(repo, "a", "b"))).toBe(repo);
    mkdirSync(join(root, "loose"));
    expect(projectRoot(join(root, "loose"))).toBe(join(root, "loose"));
  });

  test("a git worktree maps to its main repo, like git rev-parse --git-common-dir", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "f"), "x");
    git(repo, "add", "f");
    git(repo, "commit", "-qm", "init");
    const wt = join(root, "repo.wt", "one");
    git(repo, "worktree", "add", "-q", "-b", "one", wt);
    mkdirSync(join(wt, "sub"));

    const common = realpathSync(resolve(wt, git(wt, "rev-parse", "--git-common-dir"), ".."));
    expect(projectRoot(join(wt, "sub"))).toBe(common);
    expect(projectKey(join(wt, "sub"))).toBe(projectKey(repo));
  });

  test("a .git file that claims another repo's worktree, without its back-pointer, is its own project (V-L10)", () => {
    const victim = join(root, "trusted");
    mkdirSync(join(victim, ".git", "worktrees", "x"), { recursive: true });
    writeFileSync(join(victim, ".git", "worktrees", "x", "commondir"), "../..\n");
    const clone = join(root, "clone");
    mkdirSync(clone);
    writeFileSync(join(clone, ".git"), `gitdir: ${join(victim, ".git", "worktrees", "x")}\n`);
    expect(projectRoot(clone)).toBe(clone);
    // Pointing back at another folder's .git is not enough either.
    writeFileSync(
      join(victim, ".git", "worktrees", "x", "gitdir"),
      `${join(root, "other", ".git")}\n`,
    );
    expect(projectRoot(clone)).toBe(clone);
    // The real layout: the worktree's gitdir file names this .git file.
    writeFileSync(join(victim, ".git", "worktrees", "x", "gitdir"), `${join(clone, ".git")}\n`);
    expect(projectRoot(clone)).toBe(victim);
  });
});

describe("trust store", () => {
  const key = "/work/repo";

  test("nothing is trusted until added; items are fingerprints, so a changed item is not", () => {
    expect(isTrusted(dataDir, key, "safety", allowItem("bash", "npm test *"))).toBe(false);
    addTrusted(dataDir, key, "safety", [allowItem("bash", "npm test *"), proofItem("bun test")]);
    expect(isTrusted(dataDir, key, "safety", allowItem("bash", "npm test *"))).toBe(true);
    expect(isTrusted(dataDir, key, "safety", proofItem("bun test"))).toBe(true);
    expect(isTrusted(dataDir, key, "safety", allowItem("bash", "npm *"))).toBe(false);
    expect(isTrusted(dataDir, "/other", "safety", proofItem("bun test"))).toBe(false);
    // Key order does not change a fingerprint.
    expect(isTrusted(dataDir, key, "safety", { command: "bun test", kind: "proof" })).toBe(true);
  });

  test("setTrusted replaces a section; revokeTrust forgets a section or the whole repo", () => {
    addTrusted(dataDir, key, "hooks", [{ a: 1 }]);
    setTrusted(dataDir, key, "hooks", [{ b: 2 }]);
    expect(isTrusted(dataDir, key, "hooks", { a: 1 })).toBe(false);
    expect(isTrusted(dataDir, key, "hooks", { b: 2 })).toBe(true);
    addTrusted(dataDir, key, "safety", [proofItem("make test")]);
    expect(revokeTrust(dataDir, key, "hooks")).toBe(true);
    expect(isTrusted(dataDir, key, "hooks", { b: 2 })).toBe(false);
    expect(isTrusted(dataDir, key, "safety", proofItem("make test"))).toBe(true);
    expect(revokeTrust(dataDir, key)).toBe(true);
    expect(readTrust(dataDir)[key]).toBeUndefined();
    expect(revokeTrust(dataDir, key)).toBe(false);
  });

  test("lives in hamness's user config next to other settings, readable only by the user", () => {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ safety: { mode: "ask" } }));
    addTrusted(dataDir, key, "safety", [proofItem("bun test")]);
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(config.safety).toEqual({ mode: "ask" });
    expect(Object.keys(config.trust.projects)).toEqual([key]);
    expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
  });

  test("a broken config file trusts nothing instead of throwing", () => {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "config.json"), "{ nope");
    expect(isTrusted(dataDir, key, "safety", proofItem("bun test"))).toBe(false);
  });
});
