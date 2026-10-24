import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { migrations } from "../db/migrations/index.ts";
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from "./daemon.ts";
import { getStatus } from "./status.ts";

let home: ReturnType<typeof tempHome>;
const started: RunningDaemon[] = [];

async function start() {
  const d = await startDaemon({ dataDir: home.dir, port: 0 });
  started.push(d);
  return d;
}

beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  for (const d of started.splice(0)) await d.stop();
  home.cleanup();
});

const tokenOf = () => readFileSync(dataPaths(home.dir).token, "utf8").trim();
const auth = () => ({ authorization: `Bearer ${tokenOf()}` });

describe("daemon HTTP API", () => {
  test("health without a token is 401", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/health`);
    expect(res.status).toBe(401);
  });

  test("health with a wrong token is 401", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/health`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("health with the token reports the migrated schema", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/health`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(body.schemaVersion).toBe(migrations.length);
  });

  test("unknown routes are 404 once authorized", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/nope`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  test("binds to the loopback address only", async () => {
    const d = await start();
    expect(new URL(d.url).hostname).toBe("127.0.0.1");
  });

  test("rejects requests whose Host is not localhost (DNS rebinding)", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/health`, {
      headers: { ...auth(), host: "evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("writes the token file readable by the owner only", async () => {
    await start();
    const mode = statSync(dataPaths(home.dir).token).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(tokenOf()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("daemon event stream", () => {
  test("a WebSocket without the token is refused", async () => {
    const d = await start();
    const res = await fetch(`${d.url}/v1/events`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
  });

  test("a WebSocket with the token gets a hello, then broadcast events", async () => {
    const d = await start();
    const ws = new WebSocket(`${d.wsUrl}/v1/events?token=${tokenOf()}`);
    const received: Array<{ type: string }> = [];
    const got = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`only got ${JSON.stringify(received)}`)),
          2000,
        );
        const check = () => {
          if (received.length >= n) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(check, 5);
        };
        check();
      });
    ws.onmessage = (e) => received.push(JSON.parse(String(e.data)));

    await got(1);
    expect(received[0]?.type).toBe("daemon.hello");

    d.emit({ type: "daemon.stopping" });
    await got(2);
    expect(received[1]?.type).toBe("daemon.stopping");
    ws.close();
  });
});

describe("daemon lifecycle", () => {
  test("a second start on the same data dir is refused", async () => {
    await start();
    await expect(startDaemon({ dataDir: home.dir, port: 0 })).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  test("after stop, the daemon can start again", async () => {
    const first = await start();
    await first.stop();
    started.splice(started.indexOf(first), 1);
    const second = await start();
    const res = await fetch(`${second.url}/v1/health`, { headers: auth() });
    expect(res.status).toBe(200);
  });

  test("a state file left by a dead process does not block start", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const paths = dataPaths(home.dir);
    writeFileSync(paths.daemonState, JSON.stringify({ pid: dead.pid, url: "http://127.0.0.1:1" }));
    const d = await start();
    expect(d.pid).toBe(process.pid);
  });
  test("a state file whose pid was reused by another program does not block start", async () => {
    const other = Bun.spawn(["sleep", "10"]);
    try {
      const paths = dataPaths(home.dir);
      writeFileSync(
        paths.daemonState,
        JSON.stringify({ pid: other.pid, url: "http://127.0.0.1:9" }),
      );
      const d = await start();
      expect(d.pid).toBe(process.pid);
    } finally {
      other.kill();
    }
  });
});

describe("getStatus", () => {
  test("reports not running on an empty data dir", async () => {
    expect(await getStatus(home.dir)).toEqual({ running: false });
  });

  test("reports a running daemon with its url and pid", async () => {
    const d = await start();
    expect(await getStatus(home.dir)).toEqual({
      running: true,
      pid: process.pid,
      url: d.url,
      schemaVersion: migrations.length,
    });
  });

  test("reports not running after stop", async () => {
    const d = await start();
    await d.stop();
    started.splice(started.indexOf(d), 1);
    expect(await getStatus(home.dir)).toEqual({ running: false });
  });
});
