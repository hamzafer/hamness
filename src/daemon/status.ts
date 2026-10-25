import { readFileSync } from "node:fs";
import { dataPaths } from "../config/paths.ts";
import { readLiveState } from "./state.ts";

/** What this build's daemon API can do; a client needs them all (`launch`: ADR 0023). */
export const DAEMON_FEATURES: readonly string[] = ["launch"];

export type DaemonStatus =
  | { running: false }
  | {
      running: true;
      pid: number;
      url: string;
      schemaVersion: number;
      /** The daemon's hamness version, and what its API can do (`launch`: ADR 0023). */
      version?: string;
      features?: string[];
    };

/** Asks the daemon recorded in the data dir whether it is up, using the token file. */
export async function getStatus(dataDir: string, timeoutMs = 1000): Promise<DaemonStatus> {
  const paths = dataPaths(dataDir);
  const state = readLiveState(paths.daemonState);
  if (!state?.url) return { running: false };

  let token: string;
  try {
    token = readFileSync(paths.token, "utf8").trim();
  } catch {
    return { running: false };
  }

  try {
    const res = await fetch(`${state.url}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { running: false };
    const body = (await res.json()) as {
      pid: number;
      schemaVersion: number;
      version?: string;
      features?: string[];
    };
    return {
      running: true,
      pid: body.pid,
      url: state.url,
      schemaVersion: body.schemaVersion,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(Array.isArray(body.features) ? { features: body.features } : {}),
    };
  } catch {
    return { running: false };
  }
}
