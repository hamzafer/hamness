import { getStatus } from "../../daemon/status.ts";
import type { CliContext } from "../run.ts";

/** Exit 0 when the daemon answers, 1 when it does not. */
export async function statusCommand({ dataDir, io }: CliContext): Promise<number> {
  const status = await getStatus(dataDir);
  if (!status.running) {
    io.out("hamness daemon: not running");
    return 1;
  }
  io.out(
    `hamness daemon: running (pid ${status.pid}, ${status.url}, schema v${status.schemaVersion})`,
  );
  return 0;
}
