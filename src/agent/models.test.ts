import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePlanLogin } from "../../test/support/plan-login.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import {
  defaultModelCredential,
  listModels,
  loadModels,
  modelName,
  NotSetUpError,
  PLAN_DEFAULT_MODEL,
  parseModelSpec,
  resolveModels,
} from "./models.ts";
import { readPlanLogin } from "./plan.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const keyFile = () => join(home.dir, "keys.json");
const config = (c: Record<string, unknown>) =>
  writeFileSync(join(home.dir, "config.json"), JSON.stringify(c));

describe("the default model (ADR 0024)", () => {
  test("signed in with the ChatGPT plan: the plan's model, billed to the plan", async () => {
    writePlanLogin(home.dir);
    const m = await resolveModels({ dataDir: home.dir, env: {} });
    expect(modelName(m.model)).toBe(PLAN_DEFAULT_MODEL);
    expect(m.origin).toBe("plan");
    expect(m.billing("openai-codex")).toEqual({ kind: "plan" });
  });

  test("the plan tier picks the model: Go gets gpt-5.6-terra, Team gets gpt-6.1-sol", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    expect(readPlanLogin(home.dir)).toEqual({ tier: "go", hasAccount: true });
    expect(modelName((await resolveModels({ dataDir: home.dir, env: {} })).model)).toBe(
      "openai-codex/gpt-5.6-terra",
    );
    writePlanLogin(home.dir, { tier: "team" });
    expect(modelName((await resolveModels({ dataDir: home.dir, env: {} })).model)).toBe(
      "openai-codex/gpt-6.1-sol",
    );
  });

  test("billing follows Pi's auth state per call: a logout ends plan billing at once", async () => {
    writePlanLogin(home.dir);
    const m = await loadModels({ dataDir: home.dir, env: {} });
    expect(m.billing("openai-codex")).toEqual({ kind: "plan" });
    await m.runtime.logout("openai-codex");
    expect(m.billing("openai-codex")).toBeUndefined();
  });

  test("a logout with a skipped env key for that provider claims no API billing", async () => {
    writePlanLogin(home.dir, { provider: "openai" });
    const m = await loadModels({ dataDir: home.dir, env: { OPENAI_API_KEY: "sk-skipped" } });
    expect(m.billing("openai")).toEqual({ kind: "plan" });
    await m.runtime.logout("openai");
    // `loadKeys` never loaded the key while the plan login existed, so nothing bills.
    expect(m.billing("openai")).toBeUndefined();
  });

  test("another subscription login (Copilot) is never picked, and bills as a subscription", async () => {
    writePlanLogin(home.dir, { provider: "github-copilot" });
    await expect(resolveModels({ dataDir: home.dir, env: {} })).rejects.toBeInstanceOf(
      NotSetUpError,
    );
    const m = await loadModels({ dataDir: home.dir, env: {} });
    expect(m.billing("github-copilot")).toEqual({ kind: "subscription" });
  });

  test("signed out with no keys: not set up, with the sign-in to run", async () => {
    await expect(resolveModels({ dataDir: home.dir, env: {} })).rejects.toBeInstanceOf(
      NotSetUpError,
    );
    await expect(resolveModels({ dataDir: home.dir, env: {} })).rejects.toThrow(
      /hamness login openai/,
    );
    expect((await defaultModelCredential({ dataDir: home.dir, env: {} })).origin).toBe("none");
  });

  test("API keys but no plan: still not set up, so a stray key never starts a bill", async () => {
    const env = { ANTHROPIC_API_KEY: "k1", OPENAI_API_KEY: "k2", GEMINI_API_KEY: "k3" };
    await expect(resolveModels({ dataDir: home.dir, env })).rejects.toBeInstanceOf(NotSetUpError);
    const cred = await defaultModelCredential({ dataDir: home.dir, env });
    expect(cred.model).toBeUndefined();
  });

  test("OPENAI_API_KEY and a plan login: the plan model, on the login, never the key", async () => {
    writePlanLogin(home.dir);
    const env = { OPENAI_API_KEY: "sk-openai-env" };
    const m = await resolveModels({ dataDir: home.dir, env });
    expect(m.model.provider).toBe("openai-codex");
    expect(m.billing("openai-codex")).toEqual({ kind: "plan" });
    expect(m.billing("openai")).toEqual({ kind: "api", source: "OPENAI_API_KEY" });
    const auth = await m.runtime.getAuth("openai-codex");
    expect(auth?.source).toBe("OAuth");
    expect(JSON.stringify(auth)).not.toContain("sk-openai-env");
    const cred = await defaultModelCredential({ dataDir: home.dir, env });
    expect(cred).toMatchObject({ model: PLAN_DEFAULT_MODEL, billing: { kind: "plan" } });
  });

  test("OPENAI_API_KEY and no plan login: openai models list as API from OPENAI_API_KEY", async () => {
    const m = await loadModels({ dataDir: home.dir, env: { OPENAI_API_KEY: "sk-x" } });
    expect(m.origin).toBe("none");
    expect(m.billing("openai")).toEqual({ kind: "api", source: "OPENAI_API_KEY" });
    expect(m.billing("openai-codex")).toBeUndefined();
  });

  test("defaultModel in the user config picks an API model, with its key", async () => {
    writePlanLogin(home.dir);
    config({ defaultModel: "anthropic/claude-sonnet-5-5" });
    const m = await resolveModels({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } });
    expect(modelName(m.model)).toBe("anthropic/claude-sonnet-5-5");
    expect(m.origin).toBe("config");
    expect(m.billing("anthropic")).toEqual({ kind: "api", source: "ANTHROPIC_API_KEY" });
  });

  test("HAMNESS_MODEL wins over the config and the plan", async () => {
    writePlanLogin(home.dir);
    config({ defaultModel: "anthropic/claude-sonnet-5-5" });
    const m = await resolveModels({
      dataDir: home.dir,
      env: { HAMNESS_MODEL: "openai-codex/gpt-5.5" },
    });
    expect(modelName(m.model)).toBe("openai-codex/gpt-5.5");
    expect(m.origin).toBe("env");
  });

  test("a chosen model with no key says so in the credential", async () => {
    const cred = await defaultModelCredential({
      dataDir: home.dir,
      env: { HAMNESS_MODEL: "anthropic/claude-sonnet-5-5" },
    });
    expect(cred).toMatchObject({ model: "anthropic/claude-sonnet-5-5", origin: "env" });
    expect(cred.billing).toBeUndefined();
  });

  test("an unknown model is an error that names it", async () => {
    await expect(
      resolveModels({ dataDir: home.dir, env: { HAMNESS_MODEL: "anthropic/nope-1" } }),
    ).rejects.toThrow(/nope-1/);
  });
});

describe("API keys", () => {
  const sonnet = { HAMNESS_MODEL: "anthropic/claude-sonnet-5-5" };

  test("uses ANTHROPIC_API_KEY from the environment", async () => {
    const m = await resolveModels({
      dataDir: home.dir,
      env: { ...sonnet, ANTHROPIC_API_KEY: "k" },
    });
    expect(m.keySource).toBe("env");
    expect((await m.runtime.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "k" });
  });

  test("falls back to the key file when it is owner-only", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "file-key" }), { mode: 0o600 });
    const m = await resolveModels({ dataDir: home.dir, env: sonnet });
    expect(m.keySource).toBe("file");
    expect((await m.runtime.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "file-key" });
  });

  test("refuses a key file others can read", async () => {
    writeFileSync(keyFile(), JSON.stringify({ anthropic: "file-key" }));
    chmodSync(keyFile(), 0o644);
    await expect(resolveModels({ dataDir: home.dir, env: sonnet })).rejects.toThrow(/0600/);
  });

  test("loads another provider's key from the key file; an env var wins", async () => {
    writeFileSync(keyFile(), JSON.stringify({ openai: "file-openai" }), { mode: 0o600 });
    let m = await resolveModels({ dataDir: home.dir, env: sonnet });
    expect((await m.runtime.getAuth("openai"))?.auth).toMatchObject({ apiKey: "file-openai" });
    m = await resolveModels({
      dataDir: home.dir,
      env: { ...sonnet, OPENAI_API_KEY: "env-openai" },
    });
    expect((await m.runtime.getAuth("openai"))?.auth).toMatchObject({ apiKey: "env-openai" });
  });

  test("refuses a Claude subscription token: Anthropic is API key only", async () => {
    await expect(
      resolveModels({ dataDir: home.dir, env: { ...sonnet, ANTHROPIC_OAUTH_TOKEN: "sub-token" } }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
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
  test("API models carry prices from hamness's table and where the key is from", async () => {
    const m = await loadModels({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } });
    const list = await listModels(m.runtime, m.billing);
    expect(list.find((x) => x.id === "anthropic/claude-opus-5-5")).toMatchObject({
      provider: "anthropic",
      priced: true,
      inputPerMTok: 4,
      outputPerMTok: 20,
      billing: { kind: "api", source: "ANTHROPIC_API_KEY" },
    });
  });

  test("plan models come first, the default on top; Go hides the models it can't use", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    const m = await loadModels({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } });
    const list = await listModels(m.runtime, m.billing, m.planTier);
    expect(list[0]).toMatchObject({ id: "openai-codex/gpt-5.6-terra", billing: { kind: "plan" } });
    const plan = list.filter((x) => x.billing?.kind === "plan").map((x) => x.id);
    expect(plan.sort()).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"]);
    const firstApi = list.findIndex((x) => x.billing?.kind === "api");
    expect(firstApi).toBe(plan.length);
  });
});
