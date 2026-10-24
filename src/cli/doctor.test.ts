import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("with no key: says how to add one, and fails", async () => {
    const t = io();
    expect(await runCli(["doctor"], env(), t.cli)).toBe(1);
    const key = line(t.text(), "anthropic/claude-opus-5-5");
    expect(key).toMatch(/^fail/);
    expect(t.text()).toContain("hamness keys set anthropic");
    expect(t.text()).toContain("ANTHROPIC_API_KEY");
  });

  test("with a key in the key file: ok, and the key is never printed", async () => {
    writeFileSync(join(home.dir, "keys.json"), JSON.stringify({ anthropic: SECRET }), {
      mode: 0o600,
    });
    const t = io();
    expect(await runCli(["doctor"], env(), t.cli)).toBe(0);
    expect(line(t.text(), "anthropic/claude-opus-5-5")).toMatch(/^ok .*key file/);
    expect(t.text()).not.toContain(SECRET);
    expect(t.text()).not.toContain("0123456789");
  });

  test("a key from the environment is named, never shown", async () => {
    const t = io();
    expect(await runCli(["doctor"], env({ ANTHROPIC_API_KEY: SECRET }), t.cli)).toBe(0);
    expect(line(t.text(), "anthropic/claude-opus-5-5")).toContain("ANTHROPIC_API_KEY");
    expect(t.text()).not.toContain(SECRET);
  });

  test("reports Bun, the mode, the daemon, gh and the Claude Code setup", async () => {
    mkdirSync(join(claudeDir, "skills", "greet"), { recursive: true });
    writeFileSync(
      join(claudeDir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Say hi\n---\nHi.\n",
    );
    const t = io();
    await runCli(["doctor"], env({ ANTHROPIC_API_KEY: SECRET }), t.cli);
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
    await runCli(["doctor"], env({ ANTHROPIC_API_KEY: SECRET }), t.cli);
    expect(line(t.text(), "Data dir")).toMatch(/^warn .*chmod 700/);
  });

  test("a config.json that is not JSON fails with the file and the problem", async () => {
    writeFileSync(join(home.dir, "config.json"), "{ not json");
    const t = io();
    expect(await runCli(["doctor"], env({ ANTHROPIC_API_KEY: SECRET }), t.cli)).toBe(1);
    expect(line(t.text(), "Config")).toMatch(/^fail .*config\.json.*not valid JSON/);
  });
});
