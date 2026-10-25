import { describeDaemon, findDaemons } from "../../daemon/processes.ts";
import { getStatus } from "../../daemon/status.ts";
import type { CliContext } from "../run.ts";

export const STATUS_USAGE = [
  "Usage: hamness status",
  "",
  "Says whether the daemon is running (exit 0) or not (exit 1), with its pid and URL,",
  "and lists stray daemon processes for this data dir (ones that no longer answer).",
].join("\n");

/** Exit 0 when the daemon answers, 1 when it does not. */
export async function statusCommand({ dataDir, io }: CliContext): Promise<number> {
  const status = await getStatus(dataDir);
  if (status.running) {
    io.out(
      `hamness daemon: running (pid ${status.pid}, ${status.url}, schema v${status.schemaVersion})`,
    );
  } else {
    io.out("hamness daemon: not running");
  }
  const strays = findDaemons(dataDir).filter(
    (p) => p.pid !== process.pid && (!status.running || p.pid !== status.pid),
  );
  if (strays.length) {
    io.out(
      `hamness daemon: ${strays.length} stray daemon process${strays.length === 1 ? "" : "es"} for this data dir:`,
    );
    for (const p of strays) io.out(`  ${describeDaemon(p)}`);
    io.out("  stop them all with `hamness stop --all`");
  }
  return status.running ? 0 : 1;
}
