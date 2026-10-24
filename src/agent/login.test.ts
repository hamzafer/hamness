import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AuthInteraction, LoginOptions } from "@earendil-works/pi-ai";
import { tempHome } from "../../test/support/temp-home.ts";
import type { CliIo } from "../cli/io.ts";
import { type LoginRuntime, login } from "./login.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const TOKEN = "oauth-access-token-secret";

/** A stand-in for Pi's ModelRuntime: scripts what the OAuth flow does, records the call. */
function fakeRuntime(flow: (i: AuthInteraction, o?: LoginOptions) => Promise<void>) {
  const calls: { provider: string; type: string; deviceId?: string }[] = [];
  const runtime: LoginRuntime = {
    async login(provider, type, interaction, options) {
      calls.push({
        provider,
        type,
        ...(options?.getDeviceId ? { deviceId: options.getDeviceId() } : {}),
      });
      await flow(interaction, options);
      return { type: "oauth", access: TOKEN, refresh: "r", expires: Date.now() + 1000 } as never;
    },
  };
  return { runtime, calls };
}

function io(answers: string[] = []) {
  const lines: string[] = [];
  const asked: string[] = [];
  const cli: CliIo = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    readLine: async (p) => {
      asked.push(p);
      return answers.shift() ?? "";
    },
    readSecret: async (p) => {
      asked.push(p);
      return answers.shift() ?? "";
    },
  };
  return { cli, lines, asked };
}

describe("login", () => {
  test("ChatGPT login through Pi: shows the sign-in URL, passes the pasted code, never prints the token", async () => {
    let pasted = "";
    const { runtime, calls } = fakeRuntime(async (i) => {
      i.notify({ type: "auth_url", url: "https://auth.example/authorize?x=1" });
      pasted = await i.prompt({ type: "manual_code", message: "Paste the redirect URL" });
    });
    const t = io(["https://localhost/cb?code=abc"]);
    const code = await login({ provider: "openai", runtime, io: t.cli, dataDir: home.dir });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "openai", type: "oauth" });
    expect(pasted).toBe("https://localhost/cb?code=abc");
    expect(t.lines.join("\n")).toContain("https://auth.example/authorize?x=1");
    expect(t.lines.join("\n")).not.toContain(TOKEN);
  });

  test("gives Pi a stable device id kept in the data dir (0600)", async () => {
    const a = fakeRuntime(async () => {});
    const b = fakeRuntime(async () => {});
    await login({ provider: "openai", runtime: a.runtime, io: io().cli, dataDir: home.dir });
    await login({ provider: "openai", runtime: b.runtime, io: io().cli, dataDir: home.dir });
    const id = a.calls[0]?.deviceId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.calls[0]?.deviceId).toBe(id);
    const file = join(home.dir, "pi", "device-id");
    expect(readFileSync(file, "utf8").trim()).toBe(id ?? "");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("shows a device code when the flow uses one", async () => {
    const { runtime } = fakeRuntime(async (i) => {
      i.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://x.example/device",
      });
    });
    const t = io();
    await login({ provider: "openai", runtime, io: t.cli, dataDir: home.dir });
    expect(t.lines.join("\n")).toContain("ABCD-1234");
    expect(t.lines.join("\n")).toContain("https://x.example/device");
  });

  test("refuses Claude subscription login and says to use an API key", async () => {
    const { runtime, calls } = fakeRuntime(async () => {});
    const t = io();
    expect(await login({ provider: "anthropic", runtime, io: t.cli, dataDir: home.dir })).toBe(1);
    expect(calls).toHaveLength(0);
    expect(t.lines.join("\n")).toContain("hamness keys set anthropic");
  });

  test("a failed login is exit 1 with Pi's reason", async () => {
    const { runtime } = fakeRuntime(async () => {
      throw new Error("user closed the browser");
    });
    const t = io();
    expect(await login({ provider: "openai", runtime, io: t.cli, dataDir: home.dir })).toBe(1);
    expect(t.lines.join("\n")).toContain("user closed the browser");
  });
});
