import { readFileSync } from "node:fs";
import { dataPaths } from "../config/paths.ts";
import { readLiveState } from "./state.ts";

export type DaemonStatus =
  | { running: false }
  | { running: true; pid: number; url: string; schemaVersion: number };

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
    const body = (await res.json()) as { pid: number; schemaVersion: number };
    return { running: true, pid: body.pid, url: state.url, schemaVersion: body.schemaVersion };
  } catch {
    return { running: false };
  }
}
