import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** What `daemon.json` holds while a daemon runs. `url` is missing while it starts. */
export interface DaemonState {
  pid: number;
  url?: string;
  startedAt?: number;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readState(path: string): DaemonState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonState>;
    return typeof parsed.pid === "number" ? (parsed as DaemonState) : null;
  } catch {
    return null;
  }
}

/** The state file only if its process is still alive. */
export function readLiveState(path: string): DaemonState | null {
  const state = readState(path);
  return state && isProcessAlive(state.pid) ? state : null;
}

/**
 * Claims the state file for this process with an exclusive create.
 * Returns the live owner if another daemon holds it. A stale file is replaced.
 */
export function claimState(
  path: string,
  pid: number,
): { ok: true } | { ok: false; owner: DaemonState } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid } satisfies DaemonState), {
        flag: "wx",
        mode: 0o600,
      });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readState(path);
      if (owner && isProcessAlive(owner.pid)) return { ok: false, owner };
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not claim ${path}`);
}

export function writeState(path: string, state: DaemonState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Removes the state file if this process still owns it. */
export function releaseState(path: string, pid: number): void {
  if (readState(path)?.pid === pid) rmSync(path, { force: true });
}
