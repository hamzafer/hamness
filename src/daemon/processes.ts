import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { dataPaths, resolveDataDir } from "../config/paths.ts";
import { isProcessAlive, readState } from "./state.ts";

/** A `hamness daemon` process found in the process table. */
export interface DaemonProcessInfo {
  pid: number;
  /** When it started, as `ps` prints it (local time). */
  started: string;
  /** How long it has run, in seconds. */
  ageSeconds: number;
}

/**
 * `bun [flags] <...>/main.ts daemon` or `bun [flags] <...>/hamness daemon`: how `ensureDaemon`,
 * the global `hamness` shim and `bun src/cli/main.ts daemon` all appear in `ps`.
 */
const DAEMON_COMMAND =
  /^(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+\S*(?:main\.ts|hamness)\s+daemon(?:\s|$)/;

export function isDaemonCommand(command: string): boolean {
  return DAEMON_COMMAND.test(command.trim());
}

/** `[[dd-]hh:]mm:ss` (ps `etime`) in seconds. */
export function parseElapsed(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (rest ?? "").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h = 0, m = 0, s = 0] = parts;
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

function ps(args: string[]): string {
  try {
    const out = Bun.spawnSync(["ps", ...args], { stdout: "pipe", stderr: "ignore" });
    return out.exitCode === 0 ? out.stdout.toString() : "";
  } catch {
    return "";
  }
}

/**
 * One variable from a process's environment: `/proc/<pid>/environ` on Linux, `ps -E` on macOS
 * (which appends `NAME=value` pairs to the command line, so a value runs to the next ` NAME=`).
 * Undefined when unset or unreadable (another user's process).
 */
export function processEnv(pid: number, name: string): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
    }
    return undefined;
  } catch {
    // No procfs: ask ps.
  }
  return envFromPsLine(ps(["-E", "-ww", "-o", "command=", "-p", String(pid)]), name);
}

export function envFromPsLine(line: string, name: string): string | undefined {
  const at = line.search(new RegExp(`(?:^|\\s)${name}=`));
  if (at < 0) return undefined;
  const start = line.indexOf(`${name}=`, at) + name.length + 1;
  const rest = line.slice(start).replace(/\n$/, "");
  const next = rest.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** `path` resolved, through symlinks when it exists (macOS's /var is /private/var). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The data dir a daemon process serves, from its env; undefined when its env is unreadable. */
function dataDirOf(pid: number): string | undefined {
  const home = processEnv(pid, "HAMNESS_HOME");
  if (home) return resolve(home);
  const userHome = processEnv(pid, "HOME");
  if (!userHome) return undefined;
  const xdg = processEnv(pid, "XDG_DATA_HOME");
  return resolveDataDir(xdg ? { XDG_DATA_HOME: xdg } : {}, process.platform, userHome);
}

/** Whether `pid` is alive and its command line is a `hamness daemon` (pids get reused). */
export function isDaemonProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const command = ps(["-ww", "-o", "command=", "-p", String(pid)]);
  // No ps output: can't tell, so trust the pid file that named it.
  return command.trim() === "" || isDaemonCommand(command);
}

/**
 * Every `hamness daemon` process serving `dataDir`, matched on the command line and the
 * process's HAMNESS_HOME (best effort: a process whose env can't be read is left out).
 * Includes this process if it is one. Oldest first.
 */
export function listDaemonProcesses(dataDir: string): DaemonProcessInfo[] {
  const want = canonical(dataDir);
  const found: DaemonProcessInfo[] = [];
  for (const line of ps(["-axww", "-o", "pid=,etime=,lstart=,command="]).split("\n")) {
    // pid, etime, then lstart's five fields (`Sun Oct 25 18:33:31 2026`), then the command.
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidText, etime, started, command] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!isDaemonCommand(command)) continue;
    const pid = Number(pidText);
    const served = dataDirOf(pid);
    if (served === undefined || canonical(served) !== want) continue;
    found.push({ pid, started, ageSeconds: parseElapsed(etime) });
  }
  return found.sort((a, b) => b.ageSeconds - a.ageSeconds);
}

/** `ps`'s start time and age for one pid; undefined when ps can't say. */
function processInfo(pid: number): DaemonProcessInfo | undefined {
  const m = ps(["-o", "etime=,lstart=", "-p", String(pid)]).match(
    /^\s*(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)/,
  );
  return m?.[1] && m[2] ? { pid, started: m[2], ageSeconds: parseElapsed(m[1]) } : undefined;
}

export interface FoundDaemon extends DaemonProcessInfo {
  /** Named by the data dir's lock file (a daemon that started here and has not exited). */
  locked: boolean;
}

/**
 * Every daemon process for `dataDir`: those `ps` finds, plus the pids its lock file and
 * daemon.json name when they are live daemon processes (their env may be unreadable).
 */
export function findDaemons(dataDir: string): FoundDaemon[] {
  const paths = dataPaths(dataDir);
  const lockPid = readState(paths.daemonLock)?.pid;
  const byPid = new Map<number, FoundDaemon>();
  for (const p of listDaemonProcesses(dataDir))
    byPid.set(p.pid, { ...p, locked: p.pid === lockPid });
  for (const pid of [lockPid, readState(paths.daemonState)?.pid]) {
    if (pid === undefined || byPid.has(pid) || !isDaemonProcess(pid)) continue;
    const info = processInfo(pid) ?? { pid, started: "unknown", ageSeconds: 0 };
    byPid.set(pid, { ...info, locked: pid === lockPid });
  }
  return [...byPid.values()].sort((a, b) => b.ageSeconds - a.ageSeconds);
}

/** `pid 123 (started Sun Oct 25 18:33:31 2026)` */
export function describeDaemon(p: DaemonProcessInfo): string {
  return `pid ${p.pid} (started ${p.started})`;
}
