import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeWorktree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { addTrusted, allowItem } from "../trust/index.ts";
import { addProjectRules, loadJudgeConfig, loadSafetyConfig, projectConfigPath } from "./config.ts";

let home: ReturnType<typeof tempHome>;
let dataDir: string;
let repo: string;

beforeEach(() => {
  home = tempHome();
  dataDir = join(home.dir, "data");
  repo = join(home.dir, "repo");
  mkdirSync(dataDir);
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg", "sub"), { recursive: true });
});
afterEach(() => home.cleanup());

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

describe("loading safety config", () => {
  test("with no files: the defaults, auto mode and a 15 minute approval timeout", () => {
    const c = loadSafetyConfig(dataDir, repo);
    expect(c.mode).toBe("auto");
    expect(c.approvalTimeoutMs).toBe(15 * 60_000);
    expect(c.rules.every((r) => r.layer === "default")).toBe(true);
    expect(c.rules.length).toBeGreaterThan(10);
  });

  test("user rules come after the defaults, project rules last", () => {
    writeJson(join(dataDir, "config.json"), {
      safety: { mode: "ask", approvalTimeoutSec: 30, permission: { bash: { "npm *": "allow" } } },
    });
    writeJson(join(repo, ".hamness", "config.json"), {
      safety: { permission: { bash: { "make *": "allow" } } },
    });
    addTrusted(dataDir, realpathSync(repo), "safety", [allowItem("bash", "make *")]);
    const c = loadSafetyConfig(dataDir, join(repo, "pkg", "sub"));
    expect(c.mode).toBe("ask");
    expect(c.approvalTimeoutMs).toBe(30_000);
    const tail = c.rules.slice(-2).map((r) => `${r.layer}:${r.pattern}`);
    expect(tail).toEqual(["user:npm *", "project:make *"]);
  });

  test("the project config is found at the repo root from any folder inside it", () => {
    expect(projectConfigPath(join(repo, "pkg", "sub"))).toBe(join(repo, ".hamness", "config.json"));
    const loose = join(home.dir, "loose");
    mkdirSync(loose);
    expect(projectConfigPath(loose)).toBe(join(loose, ".hamness", "config.json"));
  });

  test("a subagent's worktree reads its main repo's project config (R-H1)", () => {
    const wt = join(home.dir, "repo.hamness-worktrees", "helper-abc123");
    fakeWorktree(repo, wt);
    writeJson(join(repo, ".hamness", "config.json"), {
      safety: { permission: { bash: { "make deploy *": "ask" } } },
    });
    expect(projectConfigPath(wt)).toBe(join(repo, ".hamness", "config.json"));
    expect(loadSafetyConfig(dataDir, wt).rules.at(-1)?.pattern).toBe("make deploy *");
  });

  test("project allow rules apply only once the repo trusts them; ask and deny always do (S-H5)", () => {
    writeJson(join(repo, ".hamness", "config.json"), {
      safety: {
        permission: { bash: { "curl *": "allow", "make deploy *": "ask" }, "*": "allow" },
      },
    });
    const untrusted = loadSafetyConfig(dataDir, repo);
    const project = (c: typeof untrusted) =>
      c.rules
        .filter((r) => r.layer === "project")
        .map((r) => `${r.tool} ${r.pattern} ${r.verdict}`);
    expect(project(untrusted)).toEqual(["bash make deploy * ask"]);
    expect(untrusted.untrusted.map((r) => r.pattern)).toEqual(["curl *", "*"]);

    addTrusted(dataDir, realpathSync(repo), "safety", [allowItem("bash", "curl *")]);
    const trusted = loadSafetyConfig(dataDir, repo);
    expect(project(trusted)).toEqual(["bash curl * allow", "bash make deploy * ask"]);
    expect(trusted.untrusted.map((r) => r.tool)).toEqual(["*"]);
  });

  test("a project config cannot change the mode", () => {
    writeJson(join(repo, ".hamness", "config.json"), { safety: { mode: "yolo" } });
    expect(loadSafetyConfig(dataDir, repo).mode).toBe("auto");
  });

  test("other top-level keys are left for other features", () => {
    writeJson(join(dataDir, "config.json"), { model: "x/y", safety: { mode: "yolo" } });
    expect(loadSafetyConfig(dataDir, repo).mode).toBe("yolo");
  });

  test("a broken file is an error that names the file", () => {
    writeFileSync(join(dataDir, "config.json"), "{ nope");
    expect(() => loadSafetyConfig(dataDir, repo)).toThrow(/config\.json/);
    writeJson(join(dataDir, "config.json"), { safety: { mode: "sometimes" } });
    expect(() => loadSafetyConfig(dataDir, repo)).toThrow(/mode/);
    writeJson(join(dataDir, "config.json"), { safety: { permission: { bash: "maybe" } } });
    expect(() => loadSafetyConfig(dataDir, repo)).toThrow(/bash/);
  });
});

describe("saving 'allow always' rules to the project config", () => {
  test("creates the file, keeps other keys, and appends so the new rule wins", () => {
    writeJson(join(repo, ".hamness", "config.json"), {
      other: true,
      safety: { permission: { bash: "ask", read: { "x/**": "deny" } } },
    });
    addProjectRules(dataDir, repo, [
      { tool: "bash", pattern: "npm test *", verdict: "allow", layer: "project" },
      { tool: "write", pattern: "~/notes/**", verdict: "allow", layer: "project" },
    ]);
    const saved = JSON.parse(readFileSync(join(repo, ".hamness", "config.json"), "utf8"));
    expect(saved).toEqual({
      other: true,
      safety: {
        permission: {
          bash: { "*": "ask", "npm test *": "allow" },
          read: { "x/**": "deny" },
          write: { "~/notes/**": "allow" },
        },
      },
    });
    const rules = loadSafetyConfig(dataDir, repo).rules.filter((r) => r.layer === "project");
    expect(rules.map((r) => `${r.tool} ${r.pattern} ${r.verdict}`)).toEqual([
      "bash * ask",
      "bash npm test * allow",
      "read x/** deny",
      "write ~/notes/** allow",
    ]);
  });

  test("an existing pattern moves to the end with its new verdict", () => {
    writeJson(join(repo, ".hamness", "config.json"), {
      safety: { permission: { bash: { "make *": "deny", "ls *": "allow" } } },
    });
    addProjectRules(dataDir, repo, [
      { tool: "bash", pattern: "make *", verdict: "allow", layer: "project" },
    ]);
    const saved = JSON.parse(readFileSync(join(repo, ".hamness", "config.json"), "utf8"));
    expect(Object.entries(saved.safety.permission.bash)).toEqual([
      ["ls *", "allow"],
      ["make *", "allow"],
    ]);
  });
});

describe("judge config", () => {
  test("defaults: Haiku 5.5 for an API key, a $1 daily budget, 500 plan calls a day, 8 seconds", () => {
    expect(loadJudgeConfig(dataDir)).toEqual({
      model: "claude-haiku-5-5",
      modelSet: false,
      dailyBudgetMicros: 1_000_000,
      dailyCallCap: 500,
      timeoutMs: 8000,
    });
  });

  test("the user config sets the model, budget and timeout; the project config cannot", () => {
    writeJson(join(dataDir, "config.json"), {
      safety: {
        judge: { model: "claude-sonnet-5-5", dailyBudgetUsd: 0.25, dailyCalls: 40, timeoutSec: 3 },
      },
    });
    writeJson(join(repo, ".hamness", "config.json"), {
      safety: { judge: { dailyBudgetUsd: 100 } },
    });
    expect(loadJudgeConfig(dataDir)).toEqual({
      model: "claude-sonnet-5-5",
      modelSet: true,
      dailyBudgetMicros: 250_000,
      dailyCallCap: 40,
      timeoutMs: 3000,
    });
  });

  test("bad values are errors that name the file and key", () => {
    for (const judge of [
      { dailyBudgetUsd: -1 },
      { model: "" },
      { timeoutSec: "8" },
      { dailyCalls: 1.5 },
      "x",
    ]) {
      writeJson(join(dataDir, "config.json"), { safety: { judge } });
      expect(() => loadJudgeConfig(dataDir)).toThrow(/config\.json: safety\.judge/);
    }
  });
});
