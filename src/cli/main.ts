#!/usr/bin/env -S bun --config=/dev/null
// --config=/dev/null: Bun would otherwise apply the bunfig.toml of whatever folder hamness runs in.
import { runCli } from "./run.ts";

process.exitCode = await runCli(process.argv.slice(2));
