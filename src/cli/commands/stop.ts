import { getStatus } from "../../daemon/status.ts";
import type { CliContext } from "../run.ts";

export const STOP_USAGE = [
  "Usage: hamness stop",
  "",
  "Stops the daemon. Running prompts stop; each directory's session resumes, with its",
  "transcript, the next time the daemon starts (`hamness` starts it). Restart it this way",
  "after adding a key or changing HAMNESS_MODEL.",
].join("\n");

/** `hamness stop`: SIGTERM to the daemon that answers for this data dir, then wait for it. */
export async function stopCommand({ dataDir, io }: CliContext): Promise<number> {
  const status = await getStatus(dataDir);
  if (!status.running) {
    io.out("hamness daemon: not running");
    return 0;
  }
  process.kill(status.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await getStatus(dataDir, 300)).running) {
      io.out(`hamness daemon: stopped (pid ${status.pid})`);
      return 0;
    }
    await Bun.sleep(50);
  }
  io.err(
    `hamness stop: pid ${status.pid} is still running after 10 s; kill it with \`kill ${status.pid}\``,
  );
  return 1;
}
