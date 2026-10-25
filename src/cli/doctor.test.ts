import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanLogin } from "../../test/support/plan-login.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let claudeDir: string;
beforeEach(() => {
  home = tempHome();
  chmodSync(home.dir, 0o700);
  claudeDir = mkdtempSync(join(tmpdir(), "hamness-claude-"));
});
afterEach(() => home.cleanup());

const SECRET = "sk-ant-test-0123456789abcdef";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { cli, out, text: () => [...out, ...err].join("\n") };
}

/** No real keys, no gh on the PATH, an empty Claude Code dir. */
const env = (over: Record<string, string> = {}) => ({
  HAMNESS_HOME: home.dir,
  CLAUDE_CONFIG_DIR: claudeDir,
  PATH: "",
  ...over,
});

/** The first line with `label` right after its level (`ok   Bun 1.4.4`). */
const line = (text: string, label: string) =>
  text.split("\n").find((l) => new RegExp(`^\\w+ +${label}`).test(l)) ?? `(no ${label} line)`;

describe("hamness doctor", () => {
  test("not set up: leads with the ChatGPT plan sign-in, API keys optional, and fails", async () => {
    const t = io();
    expect(await runCli(["doctor"], env({ OPENAI_API_KEY: SECRET }), t.cli)).toBe(1);
    expect(line(t.text(), "Model")).toMatch(/^fail +Model: not set up/);
    const lines = t.text().split("\n");
    const at = lines.findIndex((l) => l.startsWith("fail  Model"));
    expect(lines[at + 1]).toContain("Sign in with your ChatGPT plan: hamness login openai");
    expect(lines[at + 2]).toContain(
      "optional: hamness keys set anthropic|openai to use pay-per-token API models",
    );
    expect(line(t.text(), "API keys")).toContain("OPENAI_API_KEY");
    expect(t.text()).not.toContain(SECRET);
  });

  test("signed in with the plan: the model line says ChatGPT plan (subscription)", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    const t = io();
    expect(await runCli(["doctor"], env({ OPENAI_API_KEY: SECRET }), t.cli)).toBe(0);
    expect(line(t.text(), "Model")).toMatch(
      /^ok +Model openai-codex\/gpt-5\.6-terra: ChatGPT plan \(subscription\)/,
    );
    expect(line(t.text(), "ChatGPT plan")).toContain("ChatGPT plan: Go · default gpt-5.6-terra");
    expect(line(t.text(), "Judge")).toContain(
      "openai-codex/gpt-5.6-luna: ChatGPT plan, up to 500 calls a day",
    );
    expect(t.text()).not.toContain(SECRET);
    expect(t.text()).not.toContain("fake-access-token");
  });

  test("a plan login without the account claim: sign in again", async () => {
    writePlanLogin(home.dir, { account: false });
    const t = io();
    expect(await runCli(["doctor"], env(), t.cli)).toBe(1);
    expect(line(t.text(), "Model")).toMatch(/^fail +Model openai-codex\/.*no account id/);
    expect(t.text()).toContain("Sign in again: hamness login openai");
  });

  test("an API model the user chose: billed per token, key named from the key file", async () => {
    writeFileSync(join(home.dir, "keys.json"), JSON.stringify({ anthropic: SECRET }), {
      mode: 0o600,
    });
    const t = io();
    const code = await runCli(
      ["doctor"],
      env({ HAMNESS_MODEL: "anthropic/claude-opus-5-5" }),
      t.cli,
    );
    expect(code).toBe(0);
    expect(line(t.text(), "Model")).toMatch(
      /^ok +Model anthropic\/claude-opus-5-5 \(HAMNESS_MODEL\): API \(pay per token, from key file\)/,
    );
    expect(t.text()).not.toContain(SECRET);
    expect(t.text()).not.toContain("0123456789");
  });

  test("a chosen API model with no key fails and says how to add one", async () => {
    const t = io();
    expect(
      await runCli(["doctor"], env({ HAMNESS_MODEL: "anthropic/claude-opus-5-5" }), t.cli),
    ).toBe(1);
    expect(line(t.text(), "Model")).toMatch(/^fail/);
    expect(t.text()).toContain("hamness keys set anthropic");
  });

  test("reports Bun, the mode, the daemon, gh and the Claude Code setup", async () => {
    mkdirSync(join(claudeDir, "skills", "greet"), { recursive: true });
    writeFileSync(
      join(claudeDir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Say hi\n---\nHi.\n",
    );
    const t = io();
    await runCli(
      ["doctor"],
      env({ ANTHROPIC_API_KEY: SECRET, HAMNESS_MODEL: "anthropic/claude-opus-5-5" }),
      t.cli,
    );
    const text = t.text();
    expect(line(text, "Bun")).toMatch(/^ok +Bun \d+\.\d+\.\d+/);
    expect(line(text, "Safety mode")).toContain("auto");
    expect(line(text, "Daemon")).toContain("not running");
    expect(line(text, "gh")).toMatch(/^warn/);
    expect(line(text, "gh")).toContain("ci evidence");
    expect(line(text, "Claude Code")).toContain("1 skill");
  });

  test("a data dir others can read is a warning", async () => {
    chmodSync(home.dir, 0o755);
    const t = io();
    await runCli(
      ["doctor"],
      env({ ANTHROPIC_API_KEY: SECRET, HAMNESS_MODEL: "anthropic/claude-opus-5-5" }),
      t.cli,
    );
    expect(line(t.text(), "Data dir")).toMatch(/^warn .*chmod 700/);
  });

  test("a config.json that is not JSON fails with the file and the problem", async () => {
    writeFileSync(join(home.dir, "config.json"), "{ not json");
    const t = io();
    expect(
      await runCli(
        ["doctor"],
        env({ ANTHROPIC_API_KEY: SECRET, HAMNESS_MODEL: "anthropic/claude-opus-5-5" }),
        t.cli,
      ),
    ).toBe(1);
    expect(line(t.text(), "Config")).toMatch(/^fail .*config\.json.*not valid JSON/);
  });
});

describe("the older OpenAI sign-in (Pi's Sign in with ChatGPT, provider openai)", () => {
  const authJson = () => JSON.parse(readFileSync(join(home.dir, "pi", "auth.json"), "utf8"));

  test("doctor names it next to the Codex plan login and how to remove only it", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    writePlanLogin(home.dir, { provider: "openai" });
    const t = io();
    expect(await runCli(["doctor"], env(), t.cli)).toBe(0);
    expect(line(t.text(), "Model")).toMatch(/^ok +Model openai-codex\//);
    expect(line(t.text(), "An older OpenAI sign-in")).toMatch(
      /^info +An older OpenAI sign-in .*api\.openai\.com.*ChatGPT plan/,
    );
    expect(t.text()).toContain("hamness logout openai-api");
    expect(t.text()).not.toContain("fake-access-token");
  });

  test("hamness logout openai-api removes it and keeps the Codex plan login", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    writePlanLogin(home.dir, { provider: "openai" });
    const t = io();
    expect(await runCli(["logout", "openai-api"], env(), t.cli)).toBe(0);
    expect(Object.keys(authJson())).toEqual(["openai-codex"]);
    expect(t.text()).toContain("Signed out of the older OpenAI sign-in");
  });

  test("hamness logout openai still removes both", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    writePlanLogin(home.dir, { provider: "openai" });
    expect(await runCli(["logout", "openai"], env(), io().cli)).toBe(0);
    expect(Object.keys(authJson())).toEqual([]);
  });
});
