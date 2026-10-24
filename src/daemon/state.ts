import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

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
 * Claims the state file for this process. The claim is written to a temp file and
 * hard-linked into place, so it appears whole and only one process can win (S-L4).
 * Returns the live owner if another daemon holds it. A stale file (dead pid, or
 * unreadable) is replaced only under a short lock, so two claimers can't both
 * remove it and each think they won.
 */
export function claimState(
  path: string,
  pid: number,
): { ok: true } | { ok: false; owner: DaemonState } {
  const tmp = `${path}.${pid}.claim`;
  writeFileSync(tmp, JSON.stringify({ pid } satisfies DaemonState), { mode: 0o600 });
  try {
    if (link(tmp, path)) return { ok: true };
    const owner = readLiveState(path);
    if (owner) return { ok: false, owner };
    return withLock(`${path}.lock`, tmp, () => {
      // Under the lock: only replace what is still stale.
      const now = readLiveState(path);
      if (now) return { ok: false, owner: now };
      rmSync(path, { force: true });
      if (link(tmp, path)) return { ok: true };
      const winner = readLiveState(path);
      if (winner) return { ok: false, owner: winner };
      throw new Error(`could not claim ${path}`);
    });
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Hard-links `from` to `to`; false if `to` exists. */
function link(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Runs `fn` holding `lock` (a file naming its pid; `mine` is our pid file to link). */
function withLock<T>(lock: string, mine: string, fn: () => T): T {
  const deadline = Date.now() + 5000;
  while (!link(mine, lock)) {
    // A holder that died inside the lock left it behind.
    if (!readLiveState(lock)) rmSync(lock, { force: true });
    else if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
    else Bun.sleepSync(2);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
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
