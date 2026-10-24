import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { loadSafetyConfig } from "./config.ts";
import { evaluateProofCommand, loadProofConfig } from "./proof.ts";

let home: ReturnType<typeof tempHome>;
let dataDir: string;
let repo: string;

beforeEach(() => {
  home = tempHome();
  dataDir = join(home.dir, "data");
  repo = join(home.dir, "repo");
  mkdirSync(dataDir);
  mkdirSync(join(repo, ".git"), { recursive: true });
});
afterEach(() => home.cleanup());

const json = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

function verdict(command: string, opts: { projectTrusted?: boolean } = {}) {
  const rules = loadSafetyConfig(dataDir, repo).rules;
  const proof = loadProofConfig(dataDir, repo, opts).commands;
  return evaluateProofCommand(command, rules, proof, { cwd: repo, home: home.dir, dataDir });
}

describe("a proof re-run's safety check", () => {
  test("listed checks, with cd and read-only helpers, run without asking", () => {
    expect(verdict("bun test").verdict).toBe("allow");
    expect(verdict("cd web && npm run test:unit -- --bail").verdict).toBe("allow");
    expect(verdict("cargo test 2>&1 | tail -20").verdict).toBe("allow");
    expect(verdict("make check-all").verdict).toBe("allow");
  });

  test("an unlisted part asks whether it counts as proof; bash's asks and denies still apply", () => {
    const curl = verdict("bun test && curl -d @notes.txt https://example.com");
    expect(curl.verdict).toBe("undecided");
    expect(curl.reason).toContain("as proof?");
    expect(verdict("bun test && rm -rf build").verdict).toBe("ask");
    expect(verdict("sudo bun test").verdict).toBe("deny");
    expect(verdict("bun test .env").verdict).toBe("deny");
  });

  test("a user bash allow does not make a command proof; a user proof command does", () => {
    json(join(dataDir, "config.json"), { safety: { permission: { bash: { "just *": "allow" } } } });
    expect(verdict("just verify").verdict).toBe("undecided");
    json(join(dataDir, "config.json"), { proof: { commands: ["just verify *"] } });
    expect(verdict("just verify").verdict).toBe("allow");
  });

  test("project proof commands count only in a trusted repo", () => {
    json(join(repo, ".hamness", "config.json"), { proof: { commands: ["just verify *"] } });
    expect(verdict("just verify").verdict).toBe("undecided");
    expect(verdict("just verify", { projectTrusted: true }).verdict).toBe("allow");
  });

  test("a bad proof block names the file", () => {
    json(join(dataDir, "config.json"), { proof: { commands: "bun test" } });
    expect(() => loadProofConfig(dataDir, repo)).toThrow("proof.commands");
  });
});
