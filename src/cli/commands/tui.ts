import { defaultModelCredential } from "../../agent/models.ts";
import { DEFAULT_MODE, loadSafetyConfig } from "../../safety/config.ts";
import { loadTui } from "../../tui/loader.ts";
import type { CliContext } from "../run.ts";
import { firstRunSetup } from "../setup.ts";

export const TUI_USAGE = [
  "Usage: hamness tui   (or just `hamness`)",
  "",
  "Opens the chat for the current directory and starts the daemon if needed.",
  "Reopening it in the same directory reattaches to the session. Type /help inside for",
  "the slash commands and keys.",
].join("\n");

/** Opens the chat TUI for the current directory, starting the daemon if needed. */
export async function tuiCommand({ dataDir, env, io }: CliContext): Promise<number> {
  const cwd = process.cwd();
  const cred = await defaultModelCredential({ dataDir, env });
  if (!cred.model || !cred.billing) {
    let mode = DEFAULT_MODE;
    try {
      mode = loadSafetyConfig(dataDir, cwd).mode;
    } catch {
      // `hamness doctor` reports a broken config; setup only needs the mode.
    }
    for (const line of firstRunSetup({ cred, dataDir, mode })) io.out(line);
    return 1;
  }
  const { runTui } = await loadTui();
  return runTui({ dataDir, cwd, env, io });
}
