import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  childPids,
  type DaemonProcess,
  spawnDaemon,
  waitForMcpServer,
} from "../../test/support/daemon-process.ts";
import { eventLog } from "../../test/support/events.ts";
import { type FakeReply, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { SessionSnapshot } from "../events/types.ts";
import { DaemonAlreadyRunningError, startDaemon } from "./daemon.ts";
import { isProcessAlive } from "./state.ts";

/*
 * The daemon as a real process: SIGTERM must end it, whatever it holds open. Before the fix,
 * an MCP stdio server a session started kept Bun's event loop alive after `stop()`, so the
 * process outlived its daemon.json and `hamness stop` reported "stopped" for a live daemon.
 */

let home: ReturnType<typeof tempHome>;
let dataDir: string;
const spawned: DaemonProcess[] = [];

beforeEach(() => {
  home = tempHome();
  dataDir = join(home.dir, "data");
});
afterEach(async () => {
  for (const d of spawned.splice(0)) await d.kill();
  home.cleanup();
});

async function daemon(opts: Parameters<typeof spawnDaemon>[1] = {}) {
  const d = await spawnDaemon(dataDir, opts);
  spawned.push(d);
  return d;
}

async function attach(d: DaemonProcess, cwd: string) {
  mkdirSync(cwd, { recursive: true });
  const res = await fetch(`${d.url}/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: { id: string } }).session.id;
}

/** Polls the session's compat view until its MCP server has registered its tools (connected). */
async function waitForMcpTools(d: DaemonProcess, sessionId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${d.url}/v1/sessions/${sessionId}/compat`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    const body = (await res.json()) as { mcpServers?: Array<{ tools?: number }> };
    if (body.mcpServers?.some((s) => (s.tools ?? 0) > 0)) return;
    await Bun.sleep(25);
  }
  throw new Error("the MCP server never connected");
}

async function openSocket(d: DaemonProcess): Promise<WebSocket> {
  const ws = new WebSocket(`${d.url.replace(/^http/, "ws")}/v1/events?token=${d.token}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed"));
  });
  return ws;
}

describe("daemon process shutdown", () => {
  test("SIGTERM with no clients exits", async () => {
    const d = await daemon();
    d.proc.kill("SIGTERM");
    expect(await d.exitsWithin(6000)).toBe(true);
    expect(d.proc.exitCode).toBe(0);
  }, 20_000);

  test("SIGTERM with a WebSocket client, a session and its MCP server exits, and the MCP server too", async () => {
    const d = await daemon({ mcp: true });
    const ws = await openSocket(d);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };
    const sid = await attach(d, join(home.dir, "repo"));
    const mcp = await waitForMcpServer(d.pid);
    await waitForMcpTools(d, sid);

    d.proc.kill("SIGTERM");
    expect(await d.exitsWithin(6000)).toBe(true);
    expect(d.proc.exitCode).toBe(0);
    expect(existsSync(dataPaths(dataDir).daemonState)).toBe(false);
    for (let i = 0; i < 100 && isProcessAlive(mcp); i++) await Bun.sleep(20);
    expect(isProcessAlive(mcp)).toBe(false);
    for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(20);
    expect(closed).toBe(true);
  }, 30_000);

  test("SIGINT exits too", async () => {
    const d = await daemon({ mcp: true });
    const sid = await attach(d, join(home.dir, "repo"));
    await waitForMcpServer(d.pid);
    await waitForMcpTools(d, sid);
    d.proc.kill("SIGINT");
    expect(await d.exitsWithin(6000)).toBe(true);
    expect(childPids(d.pid)).toEqual([]);
  }, 30_000);
});

describe("RunningDaemon.stop", () => {
  test("ends a busy session and a connected client within the deadline", async () => {
    const fake = await fakeModel(home.dir);
    // The model never answers: the turn stays busy until stop aborts it.
    fake.route(() => new Promise<FakeReply>(() => {}));
    const d = await startDaemon({
      dataDir,
      port: 0,
      models: async () => fake,
      contextFiles: false,
      safety: async () => ({ allow: true as const }),
    });
    const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
    const log = await eventLog(d.wsUrl, token);
    const cwd = join(home.dir, "work");
    mkdirSync(cwd);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await fetch(`${d.url}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd }),
    });
    const snap = (await created.json()) as SessionSnapshot;
    const res = await fetch(`${d.url}/v1/sessions/${snap.session.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hang" }),
    });
    expect(res.status).toBe(202);
    await log.waitFor((e) => e.type === "agent.status" && e.busy);

    const t0 = Date.now();
    const report = await d.stop({ deadlineMs: 3000 });
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(report.open).toEqual([]);
    await log.waitFor((e) => e.type === "daemon.stopping", 1000);
    expect(existsSync(dataPaths(dataDir).daemonState)).toBe(false);
    // Stopping twice is the same stop.
    expect(await d.stop()).toBe(report);
  }, 15_000);
});

describe("a second daemon on the same data dir", () => {
  test("refuses to start while another daemon process lives, even without daemon.json", async () => {
    const d = await daemon();
    // What a daemon that stopped serving but never exited leaves: no daemon.json.
    rmSync(dataPaths(dataDir).daemonState);
    const err = await startDaemon({ dataDir, port: 0, strayWaitMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((err as Error).message).toContain(`pid ${d.pid}`);
    expect((err as Error).message).toContain("hamness stop --all");
    // The refused start gave the data dir back untouched.
    expect(existsSync(dataPaths(dataDir).daemonState)).toBe(false);
    expect(readFileSync(dataPaths(dataDir).daemonLock, "utf8")).toContain(String(d.pid));
  }, 20_000);

  test("finds one with no lock file either (a daemon from before the lock), by its process", async () => {
    const d = await daemon();
    rmSync(dataPaths(dataDir).daemonState);
    rmSync(dataPaths(dataDir).daemonLock);
    // Only a process a few seconds old counts, so a daemon that lost a start race never blocks.
    await Bun.sleep(5200);
    const err = await startDaemon({ dataDir, port: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((err as Error).message).toContain(`pid ${d.pid}`);
  }, 20_000);

  test("a daemon on another data dir does not count", async () => {
    spawned.push(await spawnDaemon(join(home.dir, "other")));
    const d = await startDaemon({ dataDir, port: 0 });
    await d.stop();
  }, 20_000);

  test("a quick restart waits for the old daemon to finish shutting down", async () => {
    const old = await daemon({ mcp: true });
    const sid = await attach(old, join(home.dir, "repo"));
    await waitForMcpServer(old.pid);
    await waitForMcpTools(old, sid);
    old.proc.kill("SIGTERM");
    // Straight away, while the old one may still be closing its sessions.
    const d = await startDaemon({ dataDir, port: 0 });
    // It had exited by then (this test is its parent, so it may not be reaped yet).
    expect(await old.exitsWithin(200)).toBe(true);
    expect(old.proc.exitCode).toBe(0);
    expect(d.pid).toBe(process.pid);
    await d.stop();
  }, 30_000);
});

describe("health while stopping", () => {
  test("never answers ok once stop has begun", async () => {
    const d = await startDaemon({ dataDir, port: 0 });
    const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
    const health = () =>
      fetch(`${d.url}/v1/health`, { headers: { authorization: `Bearer ${token}` } }).then(
        (r) => r.status,
        () => "closed",
      );
    expect(await health()).toBe(200);
    const stopping = d.stop();
    const during = await health();
    expect(during === 503 || during === "closed").toBe(true);
    await stopping;
  });
});
