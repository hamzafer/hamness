import { parseArgs } from "node:util";
import {
  DaemonAlreadyRunningError,
  DEFAULT_PORT,
  STOP_DEADLINE_MS,
  startDaemon,
} from "../../daemon/daemon.ts";
import { type BackendJudge, chooseJudge } from "../../safety/judge/index.ts";
import type { CliContext } from "../run.ts";

export const DAEMON_USAGE = [
  "Usage: hamness daemon [--port <n>]",
  "",
  "Runs the daemon in the foreground until Ctrl+C or SIGTERM. You rarely need this:",
  "`hamness` and `hamness dashboard` start it in the background when it is not running.",
  "",
  "  --port <n>  API port on 127.0.0.1 (default 7357, or HAMNESS_PORT; 0 picks a free one)",
].join("\n");

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/** Runs the daemon in the foreground until SIGINT or SIGTERM. */
export async function daemonCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  let values: { port?: string | undefined };
  try {
    ({ values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true }));
  } catch (err) {
    io.err(`hamness daemon: ${(err as Error).message}`);
    return 2;
  }
  const port = parsePort(values.port ?? env.HAMNESS_PORT);
  if (port === null) {
    io.err("hamness daemon: the port must be an integer from 0 to 65535");
    return 2;
  }

  let judge: BackendJudge | undefined;
  try {
    const choice = await chooseJudge({ dataDir, env });
    judge = choice.backend;
    if (judge) io.out(`hamness daemon: judge ${choice.model} (${choice.billing})`);
    else io.out(`hamness daemon: the judge is off: ${choice.off} (auto mode asks)`);
  } catch (err) {
    io.err(`hamness daemon: the judge is off: ${(err as Error).message}`);
  }

  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ dataDir, port, ...(judge ? { judge } : {}) });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      io.err(`hamness: ${err.message}`);
      return 1;
    }
    const message = (err as Error).message;
    if (/port \d+ in use|EADDRINUSE/i.test(message)) {
      io.err(
        `hamness daemon: port ${port} is in use; stop what holds it, or pick another with HAMNESS_PORT=<n> (0 picks a free one)`,
      );
      return 1;
    }
    io.err(`hamness daemon: failed to start: ${message}`);
    return 1;
  }

  io.out(`hamness daemon: listening on ${daemon.url} (pid ${daemon.pid})`);
  io.out(`hamness daemon: data dir ${dataDir}`);

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  io.out(`hamness daemon: ${signal}, stopping`);
  // A second signal while stopping ends the process at once.
  const now = () => {
    io.err("hamness daemon: second signal, exiting now");
    process.exit(1);
  };
  process.once("SIGINT", now);
  process.once("SIGTERM", now);
  // Backstop: stop() is bounded, but nothing may keep this process alive.
  setTimeout(() => {
    io.err("hamness daemon: still stopping after the deadline, exiting anyway");
    process.exit(1);
  }, STOP_DEADLINE_MS + 2000).unref();

  const report = await daemon.stop({ deadlineMs: STOP_DEADLINE_MS });
  if (report.open.length) {
    io.err(
      `hamness daemon: exiting with ${report.open.join(" and ")} still open after ${STOP_DEADLINE_MS / 1000} s`,
    );
  }
  io.out("hamness daemon: stopped");
  // Exit explicitly: anything still holding the event loop (a child process, a socket, a
  // timer) would otherwise keep this process alive with no daemon.json, serving nothing.
  process.exit(0);
}
