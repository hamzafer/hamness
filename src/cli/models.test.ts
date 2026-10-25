import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writePlanLogin } from "../../test/support/plan-login.ts";
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
  test("plan models first at $0 (plan) with the default marked; API models priced, key named", async () => {
    writePlanLogin(home.dir, { tier: "team" });
    const t = io();
    const code = await runCli(
      ["models"],
      { HAMNESS_HOME: home.dir, ANTHROPIC_API_KEY: "sk-ant-secret-key" },
      t.cli,
    );
    expect(code).toBe(0);
    const lines = t.out;
    expect(lines[0]).toMatch(/^\* openai-codex\/gpt-6\.1-sol .*\$0 \(plan\)/);
    const text = lines.join("\n");
    expect(text).toMatch(
      / {2}anthropic\/claude-opus-5-5 .*\$4 in \/ \$20 out per MTok · API \(pay per token, from ANTHROPIC_API_KEY\)/,
    );
    expect(text).not.toContain("sk-ant-secret-key");
  });

  test("an API key alone marks no default", async () => {
    const t = io();
    await runCli(["models"], { HAMNESS_HOME: home.dir, OPENAI_API_KEY: "sk-x" }, t.cli);
    const text = t.out.join("\n");
    expect(text).not.toMatch(/^\*/m);
    expect(text).toContain("hamness login openai");
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
