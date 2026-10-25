import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePlanLogin } from "../../test/support/plan-login.ts";
import { tempHome } from "../../test/support/temp-home.ts";

const MAIN = join(import.meta.dir, "main.ts");
let home: ReturnType<typeof tempHome>;
let daemons: Bun.Subprocess[] = [];

const env = (): Record<string, string | undefined> => ({
  ...process.env,
  HAMNESS_HOME: home.dir,
  HAMNESS_PORT: "0",
  // No real key reaches these tests, whatever the developer's shell has.
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  HAMNESS_MODEL: undefined,
});

async function run(...args: string[]) {
  return runWith({}, ...args);
}

async function runWith(over: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...env(), ...over },
    stdout: "pipe",
    stderr: "pipe",
  });
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
  test("runs in a folder whose bunfig.toml preloads something missing", async () => {
    // Bun applies the cwd's bunfig.toml to any script, the global hamness included.
    writeFileSync(join(home.dir, "bunfig.toml"), 'preload = ["./missing.ts"]\n');
    const proc = Bun.spawn([MAIN, "--help"], {
      cwd: home.dir,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).not.toContain("preload not found");
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: hamness");
  });

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

  test("stop stops a running daemon, and says so when none runs", async () => {
    const d = spawnDaemon();
    await waitForRunning();
    const r = await run("stop");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`stopped (pid ${d.pid})`);
    expect(await d.exited).toBe(0);
    expect((await run("stop")).stdout).toContain("not running");
  });

  test("a port in use is one line that says how to pick another", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const r = await runWith({ HAMNESS_PORT: String(blocker.port) }, "daemon");
      expect(r.code).toBe(1);
      expect(r.stderr.trim().split("\n")).toEqual([
        `hamness daemon: port ${blocker.port} is in use; stop what holds it, or pick another with HAMNESS_PORT=<n> (0 picks a free one)`,
      ]);
    } finally {
      blocker.stop(true);
    }
  });

  test("with no key, `hamness` shows a short setup instead of the chat", async () => {
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Welcome to hamness.");
    expect(r.stdout).toContain("Sign in with your ChatGPT plan: hamness login openai");
    expect(r.stdout).toContain("optional: hamness keys set anthropic|openai");
    expect(r.stdout).not.toContain("needs an API key");
    expect(r.stdout).toContain("Safety mode is auto");
    expect(r.stdout).toContain("hamness doctor");
    // Setup never starts the daemon.
    expect((await run("status")).code).toBe(1);
  });

  test("with a plan login but no terminal, `hamness` says the TUI needs one", async () => {
    writePlanLogin(home.dir);
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs a terminal");
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

  test("piped to a reader that stops early (head), a long listing exits 0 with no stack trace", async () => {
    // `head -1` closes the pipe after one line, so later writes hit EPIPE.
    const proc = Bun.spawn(
      ["sh", "-c", `bun "${MAIN}" models --all | head -1 >/dev/null; exit 0`],
      {
        env: env(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const proc2 = Bun.spawn(["bun", MAIN, "models", "--all"], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Read one chunk, then close our end of the pipe, like head does.
    const reader = proc2.stdout.getReader();
    await reader.read();
    await reader.cancel();
    const [stderr, code, stderr1] = await Promise.all([
      new Response(proc2.stderr).text(),
      proc2.exited,
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stderr).not.toContain("EPIPE");
    expect(stderr1).not.toContain("EPIPE");
    expect(code).toBe(0);
  });
});
