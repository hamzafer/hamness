#!/usr/bin/env -S bun --config=/dev/null
// --config=/dev/null: Bun would otherwise apply the bunfig.toml of whatever folder hamness runs in.
import { runCli } from "./run.ts";

// A reader that stops early (`hamness models | head`) closes stdout: quit quietly, like `cat`
// does, but with 141 (128 + SIGPIPE) so a cut-off `import | head` doesn't report success.
// Only EPIPE on stdout is benign; one from anywhere else (a socket, a child) is a real error.
process.stdout.on("error", (err) => {
  if ((err as { code?: unknown }).code === "EPIPE") process.exit(141);
  throw err;
});

process.exitCode = await runCli(process.argv.slice(2));
