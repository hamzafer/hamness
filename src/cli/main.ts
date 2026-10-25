#!/usr/bin/env -S bun --config=/dev/null
// --config=/dev/null: Bun would otherwise apply the bunfig.toml of whatever folder hamness runs in.
import { runCli } from "./run.ts";

const isEpipe = (err: unknown) => (err as { code?: unknown } | null)?.code === "EPIPE";

// A reader that stops early (`hamness models | head`) closes stdout: quit quietly, like `cat` does.
process.stdout.on("error", (err) => {
  if (isEpipe(err)) process.exit(0);
  throw err;
});

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
  if (isEpipe(err)) process.exit(0);
  throw err;
}
