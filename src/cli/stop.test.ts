import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  type DaemonProcess,
  spawnDaemon,
  spawnStray,
  waitForMcpServer,
} from "../../test/support/daemon-process.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { isProcessAlive } from "../daemon/state.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let dataDir: string;
const procs: Array<DaemonProcess | Subprocess> = [];

beforeEach(() => {
  home = tempHome();
  dataDir = join(home.dir, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  for (const p of procs.splice(0)) {
    if ("proc" in p) await p.kill();
    else {
      p.kill("SIGKILL");
      await p.exited;
    }
  }
  home.cleanup();
});

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  // No keys, no gh, and the test's empty Claude Code dir (doctor reads it).
  const env = {
    HAMNESS_HOME: dataDir,
    HOME: home.dir,
    PATH: "",
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(home.dir, ".claude"),
  };
  const code = await runCli(argv, env, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function daemon(opts: Parameters<typeof spawnDaemon>[1] = {}) {
  const d = await spawnDaemon(dataDir, opts);
  procs.push(d);
  return d;
}

async function stray(opts: Parameters<typeof spawnStray>[1] = {}) {
  const p = await spawnStray(dataDir, opts);
  procs.push(p);
  return p;
}

describe("hamness stop", () => {
  test("reports stopped only once the process is gone, MCP server and all", async () => {
    const d = await daemon({ mcp: true });
    const cwd = join(home.dir, "repo");
    mkdirSync(cwd);
    await fetch(`${d.url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const mcp = await waitForMcpServer(d.pid);
    await Bun.sleep(1000); // connected, like the stray daemons' servers

    const r = await cli("stop");
    expect(r.out).toBe(`hamness daemon: stopped (pid ${d.pid})`);
    expect(r.code).toBe(0);
    expect(isProcessAlive(d.pid)).toBe(false);
    for (let i = 0; i < 50 && isProcessAlive(mcp); i++) await Bun.sleep(20);
    expect(isProcessAlive(mcp)).toBe(false);
  }, 30_000);

  test("a process that ignores SIGTERM gets SIGKILL, and stop says so", async () => {
    const p = await stray({ ignoreSigterm: true });
    // It holds the lock, as a daemon that stopped serving would.
    writeFileSync(dataPaths(dataDir).daemonLock, JSON.stringify({ pid: p.pid }));
    const t0 = Date.now();
    const r = await cli("stop");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5900);
    expect(r.out).toContain(`stopped (pid ${p.pid}; it ignored SIGTERM for 6 s, so it was killed)`);
    expect(r.code).toBe(0);
    expect(p.signalCode).toBe("SIGKILL");
  }, 20_000);

  test("with nothing running it says not running", async () => {
    const r = await cli("stop");
    expect(r).toEqual({ code: 0, out: "hamness daemon: not running", err: "" });
  });

  test("not running, but a stray daemon process lives: points at --all", async () => {
    const p = await stray();
    const r = await cli("stop");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hamness daemon: not running");
    expect(r.out).toContain(`pid ${p.pid}`);
    expect(r.out).toContain("hamness stop --all");
    expect(isProcessAlive(p.pid)).toBe(true);
  });

  test("--all stops the daemon and every stray for this data dir, and nothing else", async () => {
    const d = await daemon();
    const a = await stray();
    const b = await stray();
    const elsewhere = await spawnStray(join(home.dir, "other-data"));
    procs.push(elsewhere);

    const r = await cli("stop", "--all");
    expect(r.code).toBe(0);
    for (const pid of [d.pid, a.pid, b.pid]) {
      expect(r.out).toContain(`stopped (pid ${pid})`);
      expect(isProcessAlive(pid)).toBe(false);
    }
    expect(isProcessAlive(elsewhere.pid)).toBe(true);
    expect((await cli("stop", "--all")).out).toBe(
      "hamness daemon: no daemon processes for this data dir",
    );
  }, 30_000);

  test("--all finds a daemon that lost its daemon.json and lock", async () => {
    const d = await daemon();
    rmSync(dataPaths(dataDir).daemonState);
    rmSync(dataPaths(dataDir).daemonLock);
    const r = await cli("stop", "--all");
    expect(r.out).toBe(`hamness daemon: stopped (pid ${d.pid})`);
    expect(isProcessAlive(d.pid)).toBe(false);
  }, 20_000);
});

describe("hamness status and doctor", () => {
  test("status lists stray daemon processes with their start time", async () => {
    const d = await daemon();
    const p = await stray();
    const r = await cli("status");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`running (pid ${d.pid}`);
    expect(r.out).toMatch(new RegExp(`stray.*pid ${p.pid} \\(started \\w{3} \\w{3}`, "s"));
    expect(r.out).toContain("hamness stop --all");
    expect(r.out).not.toContain(`pid ${d.pid} (started`);
  }, 20_000);

  test("status with no daemon but a stray says both", async () => {
    const p = await stray();
    const r = await cli("status");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not running");
    expect(r.out).toContain(`pid ${p.pid}`);
  });

  test("doctor warns about strays and suggests stop --all", async () => {
    const p = await stray();
    const r = await cli("doctor");
    const line = r.out.split("\n").find((l) => l.includes(`pid ${p.pid}`));
    expect(line).toStartWith("warn");
    expect(r.out).toContain("hamness stop --all");
  }, 30_000);
});
