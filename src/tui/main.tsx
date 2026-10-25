import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Launch } from "../agent/session-hub.ts";
import type { CliIo } from "../cli/io.ts";
import {
  connectToDaemon,
  type DaemonClient,
  ensureDaemon,
  type SessionCommands,
} from "../client/client.ts";
import type { Env } from "../config/paths.ts";
import type { HamnessEvent } from "../events/types.ts";
import { App } from "./app.tsx";

export interface TuiOptions {
  dataDir: string;
  cwd: string;
  env: Env;
  io: CliIo;
  /** Which session (ADR 0023): a fresh one unless `-c` or `-r <id>` asked for another. */
  launch?: Launch;
  /** `-r` with no id: open the `/resume` picker at startup. */
  openResume?: boolean;
}

/**
 * `hamness` with no command: start the daemon if needed, open a fresh session in the cwd (or
 * the one `-c` / `-r` asks for), and run the chat until Ctrl+C. Leaving never stops the session.
 */
export async function runTui(opts: TuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    opts.io.err("hamness: the TUI needs a terminal (run `hamness --help` for commands)");
    return 2;
  }

  let client: DaemonClient & SessionCommands;
  try {
    await ensureDaemon(opts.dataDir, { env: opts.env });
    client = await connectToDaemon(opts.dataDir);
  } catch (err) {
    opts.io.err(`hamness: ${(err as Error).message}`);
    return 1;
  }

  // Listen before taking the snapshot, so nothing between the two is lost.
  // The snapshot's seq drops whatever it already contains.
  const early: HamnessEvent[] = [];
  let sink: (e: HamnessEvent) => void = (e) => early.push(e);
  const close = client.subscribe((e) => sink(e));
  await client.ready;

  let snapshot: Awaited<ReturnType<DaemonClient["attach"]>>;
  try {
    snapshot = await client.attach(opts.cwd, opts.launch ?? { kind: "new" });
  } catch (err) {
    close();
    opts.io.err(`hamness: ${(err as Error).message}`);
    return 1;
  }

  const replaying: DaemonClient & SessionCommands = {
    ...client,
    subscribe(onEvent) {
      for (const e of early.splice(0)) onEvent(e);
      sink = onEvent;
      return close;
    },
  };

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const done = new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });
  await render(
    () => (
      <App
        client={replaying}
        snapshot={snapshot}
        openResume={opts.openResume ?? false}
        onExit={() => renderer.destroy()}
      />
    ),
    renderer,
  );
  await done;
  close();
  return 0;
}
