import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { addProjectRules, loadSafetyConfig, projectConfigPath } from "./config.ts";

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
    addProjectRules(repo, [
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
    addProjectRules(repo, [
      { tool: "bash", pattern: "make *", verdict: "allow", layer: "project" },
    ]);
    const saved = JSON.parse(readFileSync(join(repo, ".hamness", "config.json"), "utf8"));
    expect(Object.entries(saved.safety.permission.bash)).toEqual([
      ["ls *", "allow"],
      ["make *", "allow"],
    ]);
  });
});
