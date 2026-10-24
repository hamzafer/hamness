import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempHome } from "../../test/support/temp-home.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { cli, out, err };
}

describe("hamness models", () => {
  test("lists the models a key unlocks, marks the default, shows prices, never the key", async () => {
    const t = io();
    const code = await runCli(
      ["models"],
      { HAMNESS_HOME: home.dir, ANTHROPIC_API_KEY: "sk-ant-secret-key" },
      t.cli,
    );
    expect(code).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/\* anthropic\/claude-opus-5-5 .*\$4 in \/ \$20 out/);
    expect(text).toMatch(/ {2}anthropic\/claude-haiku-5-5 /);
    expect(text).not.toContain("sk-ant-secret-key");
  });

  test("--all lists the whole catalog, keyed or not", async () => {
    const t = io();
    expect(await runCli(["models", "--all"], { HAMNESS_HOME: home.dir }, t.cli)).toBe(0);
    expect(t.out.join("\n")).toContain("openai/gpt-5.6-luna");
  });
});

describe("hamness login", () => {
  test("refuses anthropic: Claude is API key only", async () => {
    const t = io();
    expect(await runCli(["login", "anthropic"], { HAMNESS_HOME: home.dir }, t.cli)).toBe(1);
    expect(t.err.join("\n")).toContain("hamness keys set anthropic");
  });

  test("needs a provider", async () => {
    expect(await runCli(["login"], { HAMNESS_HOME: home.dir }, io().cli)).toBe(2);
  });
});
