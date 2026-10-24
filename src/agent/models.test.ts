import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { DEFAULT_MODEL, resolveModels } from "./models.ts";

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
