import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const SECRET = "sk-test-0123456789abcdef";

/** Captures everything the CLI prints; `secret` is what the user types at the hidden prompt. */
function io(secret: string | undefined = SECRET) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readSecret: async (prompt) => {
      prompts.push(prompt);
      if (secret === undefined) throw new Error("no input");
      return secret;
    },
  };
  return { cli, out, err, prompts, all: () => [...out, ...err, ...prompts].join("\n") };
}

const keyFile = () => join(home.dir, "keys.json");
const env = () => ({ HAMNESS_HOME: home.dir });

describe("hamness keys set", () => {
  test("stores the key from the hidden prompt in keys.json, mode 0600, and never prints it", async () => {
    const t = io();
    expect(await runCli(["keys", "set", "openai"], env(), t.cli)).toBe(0);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keyFile(), "utf8"))).toEqual({ openai: SECRET });
    expect(t.all()).not.toContain(SECRET);
    expect(t.out.join("\n")).toContain("openai");
  });

  test("keeps the other providers' keys and replaces this one", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "a-key", openai: "old" }), {
      mode: 0o600,
    });
    expect(await runCli(["keys", "set", "openai"], env(), io().cli)).toBe(0);
    expect(JSON.parse(readFileSync(keyFile(), "utf8"))).toEqual({
      anthropic: "a-key",
      openai: SECRET,
    });
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  test("refuses to touch a key file others can read, and leaves it as it was", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "a-key" }));
    chmodSync(keyFile(), 0o644);
    const t = io();
    expect(await runCli(["keys", "set", "openai"], env(), t.cli)).toBe(1);
    expect(t.err.join("\n")).toContain("0600");
    expect(JSON.parse(readFileSync(keyFile(), "utf8"))).toEqual({ anthropic: "a-key" });
    expect(t.all()).not.toContain("a-key");
  });

  test("an empty key is refused", async () => {
    const t = io("   ");
    expect(await runCli(["keys", "set", "openai"], env(), t.cli)).toBe(1);
    expect(() => statSync(keyFile())).toThrow();
  });

  test("a missing or odd provider name is a usage error", async () => {
    expect(await runCli(["keys", "set"], env(), io().cli)).toBe(2);
    expect(await runCli(["keys", "set", "../evil"], env(), io().cli)).toBe(2);
  });

  test("says when the environment overrides the stored key", async () => {
    const t = io();
    await runCli(["keys", "set", "openai"], { ...env(), OPENAI_API_KEY: "from-env" }, t.cli);
    expect(t.out.join("\n")).toContain("OPENAI_API_KEY");
    expect(t.all()).not.toContain("from-env");
  });
});

describe("hamness keys list", () => {
  test("names the providers with a key and where it comes from, never the key", async () => {
    writeFileSync(keyFile(), JSON.stringify({ openai: SECRET }), { mode: 0o600 });
    const t = io();
    expect(
      await runCli(["keys", "list"], { ...env(), ANTHROPIC_API_KEY: "env-secret" }, t.cli),
    ).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/anthropic +env \(ANTHROPIC_API_KEY\)/);
    expect(text).toMatch(/openai +key file/);
    expect(t.all()).not.toContain(SECRET);
    expect(t.all()).not.toContain("env-secret");
  });
});

describe("hamness keys remove", () => {
  test("deletes the provider's key and keeps the others, never printing them", async () => {
    writeFileSync(keyFile(), JSON.stringify({ openai: SECRET, anthropic: "sk-ant-other" }), {
      mode: 0o600,
    });
    const t = io();
    expect(await runCli(["keys", "remove", "openai"], env(), t.cli)).toBe(0);
    expect(JSON.parse(readFileSync(keyFile(), "utf8"))).toEqual({ anthropic: "sk-ant-other" });
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(t.all()).toContain("Removed the openai key");
    expect(t.all()).not.toContain(SECRET);
  });

  test("says when an env var still provides the key", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: SECRET }), { mode: 0o600 });
    const t = io();
    const code = await runCli(
      ["keys", "remove", "anthropic"],
      { ...env(), ANTHROPIC_API_KEY: "sk-ant-env" },
      t.cli,
    );
    expect(code).toBe(0);
    expect(t.all()).toContain("ANTHROPIC_API_KEY is still set in your environment");
    expect(t.all()).not.toContain("sk-ant-env");
  });

  test("a provider with no stored key is exit 1", async () => {
    const t = io();
    expect(await runCli(["keys", "remove", "openai"], env(), t.cli)).toBe(1);
    expect(t.all()).toContain("no openai key");
  });
});
