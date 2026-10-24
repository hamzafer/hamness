import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";

const MAIN = join(import.meta.dir, "main.ts");
let home: ReturnType<typeof tempHome>;
let daemons: Bun.Subprocess[] = [];

const env = () => ({ ...process.env, HAMNESS_HOME: home.dir, HAMNESS_PORT: "0" });

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function spawnDaemon() {
  const proc = Bun.spawn(["bun", MAIN, "daemon"], { env: env(), stdout: "pipe", stderr: "pipe" });
  daemons.push(proc);
  return proc;
}

async function waitForRunning() {
  for (let i = 0; i < 100; i++) {
    const r = await run("status");
    if (r.code === 0) return r;
    await Bun.sleep(50);
  }
  throw new Error("daemon never reported running");
}

beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  for (const d of daemons) {
    d.kill("SIGKILL");
    await d.exited;
  }
  daemons = [];
  home.cleanup();
});

describe("hamness CLI", () => {
  test("status says not running when no daemon is up", async () => {
    const r = await run("status");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not running");
  });

  test("daemon starts and status reports it", async () => {
    const d = spawnDaemon();
    const r = await waitForRunning();
    expect(r.stdout).toContain("running");
    expect(r.stdout).toContain(`pid ${d.pid}`);
    expect(r.stdout).toContain("http://127.0.0.1:");
  });

  test("a second daemon start is refused cleanly", async () => {
    spawnDaemon();
    await waitForRunning();
    const second = await run("daemon");
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already running");
    expect(second.stderr).not.toContain("at "); // no stack trace
  });

  test("SIGTERM stops the daemon and cleans up its state", async () => {
    const d = spawnDaemon();
    await waitForRunning();
    d.kill("SIGTERM");
    expect(await d.exited).toBe(0);
    expect(existsSync(join(home.dir, "daemon.json"))).toBe(false);
    expect((await run("status")).code).toBe(1);
  });

  test("an unknown command prints usage and exits 2", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage: hamness");
  });

  test("--version prints the version", async () => {
    const r = await run("--version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
