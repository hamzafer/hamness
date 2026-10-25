import { parseArgs } from "node:util";
import {
  describeDaemon,
  findDaemons,
  identify,
  isSameDaemon,
  lockedDaemon,
} from "../../daemon/processes.ts";
import { getStatus } from "../../daemon/status.ts";
import { type TerminateOutcome, terminate } from "../../daemon/terminate.ts";
import type { CliContext } from "../run.ts";

export const STOP_USAGE = [
  "Usage: hamness stop [--all]",
  "",
  "Stops the daemon. Running prompts stop; continue a session later with `hamness -c`.",
  "Restart the daemon this way after adding a key or changing HAMNESS_MODEL.",
  "",
  "It waits for the process to exit (SIGTERM, then SIGKILL after 6 s).",
  "",
  "  --all  Stop every hamness daemon process for this data dir, including strays that",
  "         no longer answer or have no daemon.json (`hamness status` lists them)",
].join("\n");

/** How long a daemon gets to exit after SIGTERM before it is sent SIGKILL. */
export const STOP_GRACE_MS = 6000;

/** A process to stop, and when it started, to tell it from a later process with its pid. */
interface Target {
  pid: number;
  startMs?: number;
}

/** `hamness stop`: SIGTERM to the daemon for this data dir, then wait until its process is gone. */
export async function stopCommand({ args, dataDir, io }: CliContext): Promise<number> {
  let all = false;
  try {
    ({
      values: { all = false },
    } = parseArgs({ args, options: { all: { type: "boolean" } }, strict: true }));
  } catch (err) {
    io.err(`hamness stop: ${(err as Error).message}`);
    return 2;
  }
  return all ? stopAll(dataDir, io) : stopOne(dataDir, io);
}

/** The daemon answering with this data dir's token is ours; note its start time for the SIGKILL check. */
function answering(pid: number): Target {
  const startMs = identify(pid)?.startMs;
  return startMs === undefined ? { pid } : { pid, startMs };
}

async function stopOne(dataDir: string, io: CliContext["io"]): Promise<number> {
  const status = await getStatus(dataDir);
  // The daemon that answers; else the one provably holding the lock (alive, not serving).
  const lock = lockedDaemon(dataDir);
  const target: Target | undefined = status.running
    ? answering(status.pid)
    : lock && lock.pid !== process.pid
      ? lock
      : undefined;
  if (!target) {
    io.out("hamness daemon: not running");
    const strays = findDaemons(dataDir).filter((p) => p.pid !== process.pid);
    if (strays.length === 0) return 0;
    io.out(
      `hamness daemon: but ${strayList(strays.map(describeDaemon))} still run for this data dir`,
    );
    io.out("  stop them with `hamness stop --all`");
    return 1;
  }
  return report(io, target.pid, await stop(target));
}

async function stopAll(dataDir: string, io: CliContext["io"]): Promise<number> {
  const status = await getStatus(dataDir);
  const targets = new Map<number, Target>(findDaemons(dataDir).map((p) => [p.pid, p]));
  if (status.running && !targets.has(status.pid)) {
    targets.set(status.pid, answering(status.pid));
  }
  targets.delete(process.pid);
  if (targets.size === 0) {
    io.out("hamness daemon: no daemon processes for this data dir");
    return 0;
  }
  const outcomes = await Promise.all(
    [...targets.values()].map(async (t) => ({ pid: t.pid, outcome: await stop(t) })),
  );
  let code = 0;
  for (const { pid, outcome } of outcomes) code = Math.max(code, report(io, pid, outcome));
  return code;
}

const stop = (t: Target) =>
  terminate(t.pid, { graceMs: STOP_GRACE_MS, stillOurs: () => isSameDaemon(t.pid, t.startMs) });

function report(io: CliContext["io"], pid: number, outcome: TerminateOutcome) {
  const grace = STOP_GRACE_MS / 1000;
  switch (outcome) {
    case "exited":
      io.out(`hamness daemon: stopped (pid ${pid})`);
      return 0;
    case "killed":
      io.out(
        `hamness daemon: stopped (pid ${pid}; it ignored SIGTERM for ${grace} s, so it was killed)`,
      );
      return 0;
    case "denied":
      io.err(`hamness stop: not allowed to signal pid ${pid} (another user's process?)`);
      return 1;
    case "unverified":
      io.err(
        `hamness stop: pid ${pid} is still running ${grace} s after SIGTERM, and it can no longer be confirmed as this daemon, so it was not killed; check it with \`ps -p ${pid}\``,
      );
      return 1;
    case "alive":
      io.err(
        `hamness stop: pid ${pid} is still running, even after SIGKILL; check it with \`ps -p ${pid}\``,
      );
      return 1;
  }
}

function strayList(items: string[]): string {
  return items.length === 1
    ? `1 daemon process (${items[0]})`
    : `${items.length} daemon processes (${items.join(", ")})`;
}
