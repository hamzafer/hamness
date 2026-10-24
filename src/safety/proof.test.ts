import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { projectKey } from "../compat/paths.ts";
import { addTrusted, proofItem } from "../trust/index.ts";
import { loadSafetyConfig } from "./config.ts";
import { loadProofConfig, proofListing } from "./proof.ts";
import { evaluate } from "./rules.ts";

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

function listing(command: string) {
  const rules = loadSafetyConfig(dataDir, repo).rules;
  const proof = loadProofConfig(dataDir, repo).commands;
  return proofListing(command, rules, proof, { cwd: repo, home: home.dir, dataDir });
}
const listed = (command: string) => listing(command).listed;

describe("the proof command list: what counts as evidence", () => {
  test("listed checks, with cd and read-only helpers, count", () => {
    expect(listed("bun test")).toBe(true);
    expect(listed("cd web && npm run test:unit -- --bail")).toBe(true);
    expect(listed("cargo test 2>&1 | tail -20")).toBe(true);
    expect(listed("make check-all")).toBe(true);
  });

  test("an unlisted part asks whether it counts as proof, offering its pattern", () => {
    const curl = listing("bun test && curl -d @notes.txt https://example.com");
    expect(curl.listed).toBe(false);
    expect(curl.reason).toContain("as proof?");
    expect(curl.suggestions).toEqual([
      { tool: "prove_command", pattern: "curl *", verdict: "allow", layer: "project" },
    ]);
  });

  test("a user bash allow does not make a command proof; a user proof command does", () => {
    json(join(dataDir, "config.json"), { safety: { permission: { bash: { "just *": "allow" } } } });
    expect(listed("just verify")).toBe(false);
    json(join(dataDir, "config.json"), { proof: { commands: ["just verify *"] } });
    expect(listed("just verify")).toBe(true);
  });

  test("a project proof command counts only once the repo trusts it (hamness trust)", () => {
    json(join(repo, ".hamness", "config.json"), { proof: { commands: ["just verify *"] } });
    expect(listed("just verify")).toBe(false);
    addTrusted(dataDir, projectKey(repo), "safety", [proofItem("just verify *")]);
    expect(listed("just verify")).toBe(true);
    // Changing the command needs trust again.
    json(join(repo, ".hamness", "config.json"), { proof: { commands: ["just *"] } });
    expect(listed("just verify")).toBe(false);
  });

  test("a bad proof block names the file", () => {
    json(join(dataDir, "config.json"), { proof: { commands: "bun test" } });
    expect(() => loadProofConfig(dataDir, repo)).toThrow("proof.commands");
  });
});

describe("a proof URL's safety check (S-H3)", () => {
  const evalUrl = (url: string) =>
    evaluate({ tool: "prove_url", args: { url } }, loadSafetyConfig(dataDir, repo).rules, {
      cwd: repo,
      home: home.dir,
      dataDir,
    });

  test("no rule allows a fetch by default; allow always offers the URL's origin", () => {
    const e = evalUrl("https://example.com/health?x=1");
    expect(e.verdict).toBe("undecided");
    expect(e.suggestions).toEqual([
      { tool: "prove_url", pattern: "https://example.com/*", verdict: "allow", layer: "project" },
    ]);
  });

  test("URL patterns match the whole URL, not a longer host", () => {
    json(join(dataDir, "config.json"), {
      safety: { permission: { prove_url: { "https://example.com/*": "allow" } } },
    });
    expect(evalUrl("https://example.com/health").verdict).toBe("allow");
    expect(evalUrl("https://example.com.evil.net/").verdict).toBe("undecided");
    expect(evalUrl("https://example.com@evil.net/").verdict).toBe("undecided");
  });
});
