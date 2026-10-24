import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { DEFAULT_MODEL, listModels, parseModelSpec, resolveModels } from "./models.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const keyFile = () => join(home.dir, "keys.json");

describe("resolveModels", () => {
  test("defaults to a Claude model", async () => {
    const m = await resolveModels({ dataDir: home.dir, env: {} });
    expect(`${m.model.provider}/${m.model.id}`).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL.startsWith("anthropic/claude-")).toBe(true);
  });

  test("HAMNESS_MODEL picks another model", async () => {
    const m = await resolveModels({
      dataDir: home.dir,
      env: { HAMNESS_MODEL: "anthropic/claude-sonnet-5-5" },
    });
    expect(m.model.id).toBe("claude-sonnet-5-5");
  });

  test("an unknown model is an error that names it", async () => {
    await expect(
      resolveModels({ dataDir: home.dir, env: { HAMNESS_MODEL: "anthropic/nope-1" } }),
    ).rejects.toThrow(/nope-1/);
  });

  test("uses ANTHROPIC_API_KEY from the environment", async () => {
    const m = await resolveModels({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "env-key" } });
    expect(m.keySource).toBe("env");
    expect((await m.runtime.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "env-key" });
  });

  test("falls back to the key file when it is owner-only", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "file-key" }), { mode: 0o600 });
    const m = await resolveModels({ dataDir: home.dir, env: {} });
    expect(m.keySource).toBe("file");
    expect((await m.runtime.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "file-key" });
  });

  test("refuses a key file others can read", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "file-key" }));
    chmodSync(keyFile(), 0o644);
    await expect(resolveModels({ dataDir: home.dir, env: {} })).rejects.toThrow(/0600/);
  });

  test("with no key anywhere, says so", async () => {
    const m = await resolveModels({ dataDir: home.dir, env: {} });
    expect(m.keySource).toBe("none");
  });
});

describe("keys for every provider", () => {
  test("loads another provider's key from the key file", async () => {
    writeFileSync(keyFile(), JSON.stringify({ openai: "file-openai" }), { mode: 0o600 });
    const m = await resolveModels({ dataDir: home.dir, env: {} });
    expect((await m.runtime.getAuth("openai"))?.auth).toMatchObject({ apiKey: "file-openai" });
  });

  test("an env var wins over the key file", async () => {
    writeFileSync(keyFile(), JSON.stringify({ openai: "file-openai" }), { mode: 0o600 });
    const m = await resolveModels({ dataDir: home.dir, env: { OPENAI_API_KEY: "env-openai" } });
    expect((await m.runtime.getAuth("openai"))?.auth).toMatchObject({ apiKey: "env-openai" });
  });

  test("refuses a Claude subscription token: Anthropic is API key only", async () => {
    await expect(
      resolveModels({ dataDir: home.dir, env: { ANTHROPIC_OAUTH_TOKEN: "sub-token" } }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    // With an API key set, the token is ignored rather than fatal.
    const m = await resolveModels({
      dataDir: home.dir,
      env: { ANTHROPIC_OAUTH_TOKEN: "sub-token", ANTHROPIC_API_KEY: "real-key" },
    });
    expect((await m.runtime.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "real-key" });
  });
});

describe("parseModelSpec", () => {
  test("splits provider/id and defaults a bare id to anthropic", () => {
    expect(parseModelSpec("openai/gpt-5.6-luna")).toEqual({
      provider: "openai",
      id: "gpt-5.6-luna",
    });
    expect(parseModelSpec("openrouter/meta/llama-5")).toEqual({
      provider: "openrouter",
      id: "meta/llama-5",
    });
    expect(parseModelSpec("claude-haiku-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-haiku-5-5",
    });
    expect(parseModelSpec("  ")).toBeUndefined();
  });
});

describe("listModels", () => {
  test("lists only models whose provider has a key, with prices from hamness's table", async () => {
    const m = await resolveModels({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } });
    const list = await listModels(m.runtime);
    const opus = list.find((x) => x.id === "anthropic/claude-opus-5-5");
    expect(opus).toMatchObject({
      provider: "anthropic",
      priced: true,
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
  });
});
