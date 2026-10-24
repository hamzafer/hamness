import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "../agent/models.ts";
import type { Env } from "../config/paths.ts";
import { dataPaths } from "../config/paths.ts";
import { getStatus } from "../daemon/status.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";

/** What a client (TUI, later the dashboard) needs from the daemon. */
export interface DaemonClient {
  attach(cwd: string): Promise<SessionSnapshot>;
  prompt(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** The models a session can switch to. */
  models(): Promise<ModelInfo[]>;
  /** Switches the session to `provider/id`; rejects with the daemon's reason. */
  setModel(sessionId: string, model: string): Promise<SessionSnapshot>;
  /** Opens the event stream; returns a function that closes it. */
  subscribe(onEvent: (event: HamnessEvent) => void): () => void;
  /** Resolves once the event stream is open (after `subscribe`). */
  readonly ready: Promise<void>;
}

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

/**
 * Makes sure a daemon serves `dataDir`: if none answers, starts `hamness daemon` detached
 * (output to `<dataDir>/daemon.log`) and polls its status until it is up.
 */
export async function ensureDaemon(
  dataDir: string,
  opts: { env?: Env; timeoutMs?: number } = {},
): Promise<{ url: string; started: boolean }> {
  const now = await getStatus(dataDir);
  if (now.running) return { url: now.url, started: false };

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dataDir, "daemon.log"), "a", 0o600);
  const child = spawn(process.execPath, [MAIN, "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...(opts.env ?? process.env), HAMNESS_HOME: dataDir },
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const status = await getStatus(dataDir, 500);
    if (status.running) return { url: status.url, started: true };
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`the hamness daemon did not start; see ${join(dataDir, "daemon.log")}`);
}

/** A client for the daemon that serves `dataDir`, using its token file. */
export async function connectToDaemon(dataDir: string): Promise<DaemonClient> {
  const status = await getStatus(dataDir);
  if (!status.running) throw new Error("the hamness daemon is not running");
  const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  return httpClient(status.url, token);
}

export function httpClient(url: string, token: string): DaemonClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `${method} ${path}: HTTP ${res.status}`);
    return parsed as T;
  }

  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  return {
    ready,
    attach: (cwd) => call<SessionSnapshot>("POST", "/v1/sessions", { cwd }),
    prompt: async (id, text) => {
      await call("POST", `/v1/sessions/${encodeURIComponent(id)}/prompt`, { text });
    },
    abort: async (id) => {
      await call("POST", `/v1/sessions/${encodeURIComponent(id)}/abort`);
    },
    models: async () => (await call<{ models: ModelInfo[] }>("GET", "/v1/models")).models,
    setModel: (id, model) =>
      call<SessionSnapshot>("POST", `/v1/sessions/${encodeURIComponent(id)}/model`, { model }),
    subscribe(onEvent) {
      const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/events?token=${token}`);
      ws.onopen = () => markReady();
      ws.onmessage = (e) => onEvent(JSON.parse(String(e.data)) as HamnessEvent);
      return () => ws.close();
    },
  };
}
