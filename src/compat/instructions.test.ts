import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeTree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { findInstructions } from "./instructions.ts";

let tmp: ReturnType<typeof tempHome>;
let home: string;
let repo: string;
let cwd: string;

beforeEach(() => {
  tmp = tempHome();
  home = join(tmp.dir, "home");
  repo = join(tmp.dir, "work", "repo");
  cwd = join(repo, "packages", "app");
  writeTree(tmp.dir, {
    "work/repo/.git/HEAD": "ref: refs/heads/main\n",
    "work/repo/packages/app/x": "",
  });
});
afterEach(() => tmp.cleanup());

const find = (env: Record<string, string> = {}) =>
  findInstructions({
    cwd,
    claude: { env: { HOME: home, ...env }, managedDir: join(tmp.dir, "managed") },
  });

/** Paths relative to the temp dir, so the walk above it (the real machine) doesn't matter. */
const loaded = (r: ReturnType<typeof find>) =>
  r.files.filter((f) => f.path.startsWith(tmp.dir)).map((f) => f.path.slice(tmp.dir.length + 1));

describe("instruction lookup", () => {
  test("managed, then user, then each folder from the root down, CLAUDE.local.md last per folder", () => {
    writeTree(tmp.dir, {
      "managed/CLAUDE.md": "org rules",
      "home/.claude/CLAUDE.md": "user rules",
      "home/.claude/rules/style.md": "user style",
      "work/CLAUDE.md": "work",
      "work/repo/CLAUDE.local.md": "repo local",
      "work/repo/CLAUDE.md": "repo",
      "work/repo/.claude/rules/testing.md": "repo testing",
      "work/repo/packages/app/.claude/CLAUDE.md": "app",
      "work/repo/packages/app/src/CLAUDE.md": "below cwd: lazy in Claude Code, not loaded",
    });
    const r = find();
    expect(loaded(r)).toEqual([
      "managed/CLAUDE.md",
      "home/.claude/CLAUDE.md",
      "home/.claude/rules/style.md",
      "work/CLAUDE.md",
      "work/repo/CLAUDE.md",
      "work/repo/.claude/rules/testing.md",
      "work/repo/CLAUDE.local.md",
      "work/repo/packages/app/.claude/CLAUDE.md",
    ]);
    expect(r.files.find((f) => f.path.endsWith("repo/CLAUDE.local.md"))?.scope).toBe("local");
    expect(r.files.find((f) => f.path.endsWith("home/.claude/CLAUDE.md"))?.scope).toBe("user");
  });

  test("CLAUDE_CONFIG_DIR replaces ~/.claude for the user files", () => {
    writeTree(tmp.dir, {
      "home/.claude/CLAUDE.md": "default account",
      "alt/CLAUDE.md": "second account",
    });
    expect(loaded(find({ CLAUDE_CONFIG_DIR: join(tmp.dir, "alt") }))).toEqual(["alt/CLAUDE.md"]);
  });

  test("AGENTS.md loads only when no CLAUDE.md or CLAUDE.local.md is in the cwd or above", () => {
    writeTree(tmp.dir, {
      "home/.claude/CLAUDE.md": "user rules do not count",
      "work/repo/AGENTS.md": "agents",
      "work/repo/packages/app/.claude/AGENTS.md": "app agents",
    });
    expect(loaded(find())).toEqual([
      "home/.claude/CLAUDE.md",
      "work/repo/AGENTS.md",
      "work/repo/packages/app/.claude/AGENTS.md",
    ]);

    writeTree(tmp.dir, { "work/repo/packages/CLAUDE.local.md": "now a CLAUDE file counts" });
    expect(loaded(find())).toEqual([
      "home/.claude/CLAUDE.md",
      "work/repo/packages/CLAUDE.local.md",
    ]);
  });

  test("the user's instructionFiles setting picks claude-md-and-agents-md", () => {
    writeTree(tmp.dir, {
      "home/.claude/settings.json": JSON.stringify({
        pluginConfigs: {
          "cc-plugin-agents-md@builtin": {
            options: { instructionFiles: "claude-md-and-agents-md" },
          },
        },
      }),
      "work/repo/CLAUDE.md": "repo",
      "work/repo/AGENTS.md": "agents",
    });
    expect(loaded(find())).toEqual(["work/repo/CLAUDE.md", "work/repo/AGENTS.md"]);
  });

  test("@imports expand in place, relative to the file, up to four hops, skipping code", () => {
    writeTree(tmp.dir, {
      "work/repo/CLAUDE.md": [
        "Start @docs/a.md end",
        'Not this: `@docs/b.md`, nor a@b.com, nor "@docs/b.md".',
        "```",
        "@docs/b.md",
        "```",
        "Spaced: @Design\\ Docs/c.md",
        "Missing @nope.md stays.",
      ].join("\n"),
      "work/repo/docs/a.md": "A1 @h1.md",
      "work/repo/docs/h1.md": "H1 @h2.md",
      "work/repo/docs/h2.md": "H2 @h3.md",
      "work/repo/docs/h3.md": "H3 @h4.md",
      "work/repo/docs/h4.md": "H4 @h5.md",
      "work/repo/docs/h5.md": "too deep",
      "work/repo/docs/b.md": "B",
      "work/repo/Design Docs/c.md": "C",
    });
    const repoFile = find().files.find((f) => f.path.endsWith("repo/CLAUDE.md"));
    expect(repoFile?.content).toBe(
      [
        "Start A1 H1 H2 H3 @h4.md end",
        'Not this: `@docs/b.md`, nor a@b.com, nor "@docs/b.md".',
        "```",
        "@docs/b.md",
        "```",
        "Spaced: C",
        "Missing @nope.md stays.",
      ].join("\n"),
    );
  });

  test("a project file can't import from outside the project; a user file can", () => {
    writeTree(tmp.dir, {
      "home/secret.txt": "token=abc",
      "home/.claude/CLAUDE.md": "mine: @~/notes.md",
      "home/notes.md": "my notes",
      "work/repo/CLAUDE.md": `grab @${join(home, "secret.txt")} and @../../home/secret.txt`,
    });
    const r = find();
    expect(r.files.find((f) => f.path.endsWith("home/.claude/CLAUDE.md"))?.content).toBe(
      "mine: my notes",
    );
    const repoFile = r.files.find((f) => f.path.endsWith("repo/CLAUDE.md"));
    expect(repoFile?.content).not.toContain("token=abc");
    expect(r.skipped.filter((s) => s.path.endsWith("secret.txt"))).toHaveLength(2);
  });

  test("block HTML comments are stripped, but kept inside code blocks", () => {
    writeTree(tmp.dir, {
      "work/repo/CLAUDE.md": "keep\n<!-- maintainer\nnote -->\n```\n<!-- shown -->\n```\nend",
    });
    expect(find().files.find((f) => f.path.endsWith("repo/CLAUDE.md"))?.content).toBe(
      "keep\n```\n<!-- shown -->\n```\nend",
    );
  });

  test("path-scoped rules are reported, not loaded", () => {
    writeTree(tmp.dir, {
      "work/repo/.claude/rules/api.md": '---\npaths:\n  - "src/api/**"\n---\nAPI rules',
      "work/repo/.claude/rules/always.md": "---\ndescription: x\n---\nAlways",
    });
    const r = find();
    expect(loaded(r)).toEqual(["work/repo/.claude/rules/always.md"]);
    expect(r.files[r.files.length - 1]?.content).toBe("Always");
    expect(r.skipped.map((s) => s.path)).toContain(join(repo, ".claude/rules/api.md"));
  });
});
