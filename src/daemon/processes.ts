import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { dataPaths, resolveDataDir } from "../config/paths.ts";
import { type DaemonState, readState } from "./state.ts";

/**
 * Set in the env of every daemon `ensureDaemon` starts. A process found only by scanning the
 * process table counts as a hamness daemon only with this marker, so an unrelated
 * `bun …/main.ts daemon` is never stopped or blocks a start.
 */
export const DAEMON_MARKER = "HAMNESS_DAEMON";

/** A `hamness daemon` process for a data dir. */
export interface FoundDaemon {
  pid: number;
  /** When it started (epoch ms, to the second). */
  startMs: number;
  /** `started` for people: `Sun Oct 25 2026 18:33:31`. */
  started: string;
  ageSeconds: number;
  /** Named by the data dir's lock file, start time and all. */
  locked: boolean;
}

/** What can be read about a live process. Anything unreadable is undefined. */
export interface ProcessIdentity {
  pid: number;
  /** Its command line is a `hamness daemon`; false when it can't be read. */
  isDaemon: boolean;
  startMs?: number;
  env(name: string): string | undefined;
}

const hasProcfs = () => existsSync("/proc/self/cmdline");

function ps(args: string[]): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", ...args], { stdout: "pipe", stderr: "ignore" });
    const text = out.exitCode === 0 ? out.stdout.toString().trim() : "";
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const RUNTIMES = new Set(["bun", "node"]);
const isEntry = (arg: string) => arg.endsWith("main.ts") || basename(arg) === "hamness";

/** argv of `bun [flags] …/main.ts daemon` or `bun [flags] …/hamness daemon` (the global shim). */
export function isDaemonArgv(argv: string[]): boolean {
  if (!RUNTIMES.has(basename(argv[0] ?? ""))) return false;
  return argv.some((arg, i) => i > 0 && isEntry(arg) && argv[i + 1] === "daemon");
}

/**
 * The same from `ps` on macOS, where argv is one string (paths may have spaces): the
 * executable (`comm`) is bun or node, and the command line has `main.ts daemon` or `/hamness daemon`.
 */
export function isDaemonCommand(comm: string, command: string): boolean {
  return (
    RUNTIMES.has(basename(comm.trim())) && /(?:main\.ts|\/hamness) daemon(?:\s|$)/.test(command)
  );
}

/** `[[dd-]hh:]mm:ss` (ps `etime`) in seconds. */
export function parseElapsed(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (rest ?? "").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h = 0, m = 0, s = 0] = parts;
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

/**
 * One variable from `ps -E` output on macOS, which appends `NAME=value` pairs to the command
 * line: a value runs to the next ` NAME=`.
 */
export function envFromPsLine(line: string, name: string): string | undefined {
  const at = line.search(new RegExp(`(?:^|\\s)${name}=`));
  if (at < 0) return undefined;
  const start = line.indexOf(`${name}=`, at) + name.length + 1;
  const rest = line.slice(start).replace(/\n$/, "");
  const next = rest.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Linux: start time from /proc/<pid>/stat (clock ticks since boot, at 100 Hz) and uptime. */
function procStartMs(pid: number): number | undefined {
  const stat = read(`/proc/${pid}/stat`);
  const uptime = Number(read("/proc/uptime")?.split(" ")[0]);
  if (!stat || !Number.isFinite(uptime)) return undefined;
  // Field 22, counted after the `(comm)` field, which may hold spaces.
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  if (!Number.isFinite(ticks)) return undefined;
  return Math.round(Date.now() - (uptime - ticks / 100) * 1000);
}

/** What `pid` is, or undefined when it is not alive. */
export function identify(pid: number): ProcessIdentity | undefined {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  if (hasProcfs()) {
    const argv = read(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean);
    const environ = read(`/proc/${pid}/environ`)?.split("\0");
    const startMs = procStartMs(pid);
    return {
      pid,
      isDaemon: argv ? isDaemonArgv(argv) : false,
      ...(startMs !== undefined ? { startMs } : {}),
      env: (name) =>
        environ?.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1) ?? undefined,
    };
  }
  const p = String(pid);
  const comm = ps(["-o", "comm=", "-p", p]);
  const command = ps(["-ww", "-o", "command=", "-p", p]);
  const etime = ps(["-o", "etime=", "-p", p]);
  let envLine: string | undefined | null = null;
  return {
    pid,
    isDaemon: comm !== undefined && command !== undefined && isDaemonCommand(comm, command),
    ...(etime ? { startMs: Date.now() - parseElapsed(etime) * 1000 } : {}),
    env(name) {
      if (envLine === null) envLine = ps(["-E", "-ww", "-o", "command=", "-p", p]);
      return envLine === undefined ? undefined : envFromPsLine(envLine, name);
    },
  };
}

/** `path` resolved, through symlinks when it exists (macOS's /var is /private/var). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The data dir a process serves, from its env. `undefined`: unreadable, or a relative
 * HAMNESS_HOME (relative to a cwd we don't know), so it can't be compared.
 */
function dataDirOf(id: ProcessIdentity): string | undefined {
  const home = id.env("HAMNESS_HOME");
  if (home) return isAbsolute(home) ? canonical(home) : undefined;
  const userHome = id.env("HOME");
  if (!userHome) return undefined;
  const xdg = id.env("XDG_DATA_HOME");
  return canonical(resolveDataDir(xdg ? { XDG_DATA_HOME: xdg } : {}, process.platform, userHome));
}

/**
 * Whether a process that started at `startMs` could have written a state file stamped
 * `startedAt`: a daemon stamps it within a few seconds of starting, and a pid reused by a
 * later process started after the stamp. (Start times from `ps` are to the second.)
 */
export function startMatches(startMs: number, startedAt: number): boolean {
  return startedAt >= startMs - 2000 && startedAt - startMs <= 120_000;
}

function found(id: ProcessIdentity & { startMs: number }, locked: boolean): FoundDaemon {
  return {
    pid: id.pid,
    startMs: id.startMs,
    started: new Date(id.startMs).toString().slice(0, 24),
    ageSeconds: Math.max(0, Math.round((Date.now() - id.startMs) / 1000)),
    locked,
  };
}

/**
 * The daemon a state file (daemon.lock, daemon.json) names, only when the pid is provably that
 * daemon: alive, a `hamness daemon` command line, started when the file was stamped, and (when
 * its env is readable) serving this data dir. Anything that can't be confirmed is no daemon.
 */
function fromStateFile(
  state: DaemonState | null,
  dataDir: string,
  locked: boolean,
): FoundDaemon | undefined {
  if (!state?.startedAt) return undefined;
  const id = identify(state.pid);
  if (!id?.isDaemon || id.startMs === undefined) return undefined;
  if (!startMatches(id.startMs, state.startedAt)) return undefined;
  const served = dataDirOf(id);
  if (served !== undefined && served !== canonical(dataDir)) return undefined;
  return found({ ...id, startMs: id.startMs }, locked);
}

/** The daemon holding this data dir's lock: one that started here and has not exited. */
export function lockedDaemon(dataDir: string): FoundDaemon | undefined {
  return fromStateFile(readState(dataPaths(dataDir).daemonLock), dataDir, true);
}

/** Every pid with a `hamness daemon` command line: /proc on Linux, one `ps` call elsewhere. */
function daemonCandidates(): number[] {
  if (hasProcfs()) {
    let pids: string[] = [];
    try {
      pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
    return pids
      .filter((p) => {
        const argv = read(`/proc/${p}/cmdline`)?.split("\0").filter(Boolean);
        return argv !== undefined && isDaemonArgv(argv);
      })
      .map(Number);
  }
  const out = ps(["-axww", "-o", "pid=,command="]) ?? "";
  return out
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(
      (m): m is RegExpMatchArray => !!m && /(?:main\.ts|\/hamness) daemon(?:\s|$)/.test(m[2] ?? ""),
    )
    .map((m) => Number(m[1]));
}

/**
 * Daemon processes for `dataDir` found by scanning the process table: a `hamness daemon`
 * command line, the DAEMON_MARKER env, and an absolute HAMNESS_HOME that is this data dir.
 * Best effort: a process whose env can't be read is left out.
 */
export function listDaemonProcesses(dataDir: string): FoundDaemon[] {
  const want = canonical(dataDir);
  const out: FoundDaemon[] = [];
  for (const pid of daemonCandidates()) {
    const id = identify(pid);
    if (!id?.isDaemon || id.startMs === undefined) continue;
    if (id.env(DAEMON_MARKER) !== "1") continue;
    const home = id.env("HAMNESS_HOME");
    if (!home || !isAbsolute(home) || canonical(home) !== want) continue;
    out.push(found({ ...id, startMs: id.startMs }, false));
  }
  return out;
}

/** Every daemon process for `dataDir`: the lock holder, daemon.json's pid, and what a scan finds. Oldest first. */
export function findDaemons(dataDir: string): FoundDaemon[] {
  const paths = dataPaths(dataDir);
  const byPid = new Map<number, FoundDaemon>();
  for (const p of listDaemonProcesses(dataDir)) byPid.set(p.pid, p);
  const lock = lockedDaemon(dataDir);
  if (lock) byPid.set(lock.pid, lock);
  const state = fromStateFile(readState(paths.daemonState), dataDir, false);
  if (state && !byPid.has(state.pid)) byPid.set(state.pid, state);
  return [...byPid.values()].sort((a, b) => a.startMs - b.startMs);
}

/** Whether `pid` is still the daemon process that started at `startMs` (not a reused pid). */
export function isSameDaemon(pid: number, startMs: number | undefined): boolean {
  const id = identify(pid);
  if (!id?.isDaemon || id.startMs === undefined) return false;
  return startMs === undefined || Math.abs(id.startMs - startMs) <= 2000;
}

/** `pid 123 (started Sun Oct 25 2026 18:33:31)` */
export function describeDaemon(p: FoundDaemon): string {
  return `pid ${p.pid} (started ${p.started})`;
}
