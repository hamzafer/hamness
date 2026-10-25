import { parseArgs } from "node:util";
import { dataPaths } from "../../config/paths.ts";
import { describeDaemon, findDaemons, isDaemonProcess } from "../../daemon/processes.ts";
import { readState } from "../../daemon/state.ts";
import { getStatus } from "../../daemon/status.ts";
import { terminate } from "../../daemon/terminate.ts";
import type { CliContext } from "../run.ts";

export const STOP_USAGE = [
  "Usage: hamness stop [--all]",
  "",
  "Stops the daemon. Running prompts stop; each directory's session resumes, with its",
  "transcript, the next time the daemon starts (`hamness` starts it). Restart it this way",
  "after adding a key or changing HAMNESS_MODEL.",
  "",
  "It waits for the process to exit (SIGTERM, then SIGKILL after 6 s).",
  "",
  "  --all  Stop every hamness daemon process for this data dir, including strays that",
  "         no longer answer or have no daemon.json (`hamness status` lists them)",
].join("\n");

/** How long a daemon gets to exit after SIGTERM before it is sent SIGKILL. */
export const STOP_GRACE_MS = 6000;

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

async function stopOne(dataDir: string, io: CliContext["io"]): Promise<number> {
  const status = await getStatus(dataDir);
  // The daemon that answers; else the one holding the lock (alive, but not serving).
  const lockPid = readState(dataPaths(dataDir).daemonLock)?.pid;
  const pid = status.running
    ? status.pid
    : lockPid !== undefined && lockPid !== process.pid && isDaemonProcess(lockPid)
      ? lockPid
      : undefined;
  if (pid === undefined) {
    io.out("hamness daemon: not running");
    const strays = findDaemons(dataDir).filter((p) => p.pid !== process.pid);
    if (strays.length === 0) return 0;
    io.out(
      `hamness daemon: but ${strayList(strays.map(describeDaemon))} still run for this data dir`,
    );
    io.out("  stop them with `hamness stop --all`");
    return 1;
  }
  return report(io, pid, await terminate(pid, { graceMs: STOP_GRACE_MS }));
}

async function stopAll(dataDir: string, io: CliContext["io"]): Promise<number> {
  const status = await getStatus(dataDir);
  const pids = new Set(findDaemons(dataDir).map((p) => p.pid));
  if (status.running) pids.add(status.pid);
  pids.delete(process.pid);
  if (pids.size === 0) {
    io.out("hamness daemon: no daemon processes for this data dir");
    return 0;
  }
  const outcomes = await Promise.all(
    [...pids].map(async (pid) => ({
      pid,
      outcome: await terminate(pid, { graceMs: STOP_GRACE_MS }),
    })),
  );
  let code = 0;
  for (const { pid, outcome } of outcomes) code = Math.max(code, report(io, pid, outcome));
  return code;
}

function report(io: CliContext["io"], pid: number, outcome: Awaited<ReturnType<typeof terminate>>) {
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
