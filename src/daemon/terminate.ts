import { isProcessAlive } from "./state.ts";

/**
 * How a `terminate` ended: exited on SIGTERM, needed SIGKILL, survived both, not ours to
 * signal, or outlived SIGTERM but could no longer be confirmed as ours (so no SIGKILL).
 */
export type TerminateOutcome = "exited" | "killed" | "alive" | "denied" | "unverified";

function signal(pid: number, sig: NodeJS.Signals): "sent" | "gone" | "denied" {
  try {
    process.kill(pid, sig);
    return "sent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "denied" : "gone";
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

/**
 * SIGTERM, then wait up to `graceMs` for the process to be gone; SIGKILL if it is not, and
 * wait `killWaitMs` more. Only the process's exit counts, never a state file.
 */
export async function terminate(
  pid: number,
  opts: {
    graceMs: number;
    killWaitMs?: number;
    /**
     * Checked again right before SIGKILL: is `pid` still the process we meant? False means it
     * can't be confirmed (or the pid was reused), so it is not killed: "unverified".
     */
    stillOurs?: () => boolean;
  },
): Promise<TerminateOutcome> {
  const sent = signal(pid, "SIGTERM");
  if (sent === "denied") return "denied";
  if (sent === "gone" || (await exitsWithin(pid, opts.graceMs))) return "exited";
  if (opts.stillOurs && !opts.stillOurs()) return isProcessAlive(pid) ? "unverified" : "exited";
  if (signal(pid, "SIGKILL") === "denied") return "denied";
  return (await exitsWithin(pid, opts.killWaitMs ?? 2000)) ? "killed" : "alive";
}
