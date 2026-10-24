import { mkdirSync } from "node:fs";
import { generateToken, writeTokenFile } from "../api/auth.ts";
import { startApiServer } from "../api/server.ts";
import { dataPaths } from "../config/paths.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import type { HamnessEvent } from "../events/types.ts";
import { VERSION } from "../version.ts";
import { claimState, type DaemonState, releaseState, writeState } from "./state.ts";
import { getStatus } from "./status.ts";

/** The default API port. `HAMNESS_PORT` or `--port` overrides it; 0 picks a free one. */
export const DEFAULT_PORT = 7357;

export interface DaemonOptions {
  dataDir: string;
  port?: number;
}

export interface RunningDaemon {
  readonly pid: number;
  readonly url: string;
  readonly wsUrl: string;
  readonly db: HamnessDb;
  /** Broadcasts to every connected client. */
  emit(event: HamnessEvent): void;
  stop(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly owner: DaemonState) {
    super(
      `hamness daemon is already running (pid ${owner.pid}${owner.url ? `, ${owner.url}` : ""})`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

/**
 * Starts the daemon: claims the data dir, migrates the database,
 * rotates the token and serves the localhost API.
 */
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const paths = dataPaths(opts.dataDir);
  const pid = process.pid;
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });

  let claim = claimState(paths.daemonState, pid);
  if (!claim.ok && claim.owner.url && !(await getStatus(opts.dataDir)).running) {
    // The pid is alive but nothing answers at its url: the pid was reused after a crash.
    releaseState(paths.daemonState, claim.owner.pid);
    claim = claimState(paths.daemonState, pid);
  }
  if (!claim.ok) throw new DaemonAlreadyRunningError(claim.owner);

  let db: HamnessDb | undefined;
  try {
    db = openDatabase(paths.database);
    const openDb = db;
    const token = generateToken();
    writeTokenFile(paths.token, token);

    const startedAt = Date.now();
    const api = startApiServer({
      token,
      port: opts.port ?? DEFAULT_PORT,
      health: () => ({ ok: true, version: VERSION, pid, schemaVersion: openDb.schemaVersion() }),
      hello: () => ({
        type: "daemon.hello",
        version: VERSION,
        pid,
        schemaVersion: openDb.schemaVersion(),
      }),
    });
    writeState(paths.daemonState, { pid, url: api.url, startedAt });

    let stopped = false;
    return {
      pid,
      url: api.url,
      wsUrl: api.wsUrl,
      db: openDb,
      emit: (event) => api.publish(event),
      async stop() {
        if (stopped) return;
        stopped = true;
        api.publish({ type: "daemon.stopping" });
        await api.stop();
        openDb.close();
        releaseState(paths.daemonState, pid);
      },
    };
  } catch (err) {
    db?.close();
    releaseState(paths.daemonState, pid);
    throw err;
  }
}
