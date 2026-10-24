import type { CliContext } from "../run.ts";

// OpenTUI's Solid JSX needs Bun's transform plugin. bunfig.toml only preloads it when hamness
// runs from this repo's dir, so register it here, before the first .tsx import.
const SOLID_PRELOAD = "@opentui/solid/preload";

/** Opens the chat TUI for the current directory, starting the daemon if needed. */
export async function tuiCommand({ dataDir, env, io }: CliContext): Promise<number> {
  await import(SOLID_PRELOAD);
  const { runTui } = await import("../../tui/main.tsx");
  return runTui({ dataDir, cwd: process.cwd(), env, io });
}
