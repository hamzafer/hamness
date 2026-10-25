import { defaultModelCredential } from "../../agent/models.ts";
import type { Launch } from "../../agent/session-hub.ts";
import { DEFAULT_MODE, loadSafetyConfig } from "../../safety/config.ts";
import { loadTui } from "../../tui/loader.ts";
import type { CliContext } from "../run.ts";
import { firstRunSetup } from "../setup.ts";

/** The launch flags, as `hamness --help` and `hamness tui --help` list them. */
export const TUI_OPTIONS = [
  "  -c, --continue     Continue the latest session in this directory",
  "  -r, --resume [id]  Resume a session: that one, or pick from this directory's",
];

export const TUI_USAGE = [
  "Usage: hamness tui [-c | -r [id]]   (or just `hamness`)",
  "",
  "Opens a fresh chat in the current directory and starts the daemon if needed.",
  "Closing the TUI never stops a session; continue it with -c, or pick one with",
  "-r or /resume inside. Type /help inside for the slash commands and keys.",
  "",
  "Options:",
  ...TUI_OPTIONS,
].join("\n");

/** How the TUI starts: its session, and whether the `/resume` picker opens at once. */
export type TuiLaunch = { launch: Launch; openResume: boolean };

/** Parses `hamness [tui]`'s flags (ADR 0023). */
export function parseTuiArgs(
  args: readonly string[],
): TuiLaunch | { error: string } | { help: true } {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const operands = end === -1 ? [] : args.slice(end + 1);
  if (options.some((a) => a === "-h" || a === "--help")) return { help: true };
  let cont = false;
  let resume: { id?: string } | undefined;
  for (let i = 0; i < options.length; i++) {
    const arg = options[i] as string;
    if (arg === "-c" || arg === "--continue") {
      cont = true;
    } else if (arg === "-r" || arg === "--resume") {
      const next = options[i + 1];
      resume = next !== undefined && !next.startsWith("-") ? { id: next.trim() } : {};
      if (resume.id !== undefined) i++;
    } else if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length).trim();
      if (!id) return { error: "--resume= needs a session id" };
      resume = { id };
    } else if (arg.startsWith("-")) {
      return { error: `unknown option '${arg}'` };
    } else {
      return { error: `unexpected argument '${arg}'` };
    }
  }
  // After `--`: the id of a `-r` that has none yet, even one starting with a dash.
  for (const arg of operands) {
    if (resume && !resume.id) resume = { id: arg };
    else return { error: `unexpected argument '${arg}'` };
  }
  if (cont && resume) return { error: "use -c or -r, not both" };
  if (cont) return { launch: { kind: "continue" }, openResume: false };
  if (resume?.id) return { launch: { kind: "session", id: resume.id }, openResume: false };
  return { launch: { kind: "new" }, openResume: !!resume };
}

/** Opens the chat TUI for the current directory, starting the daemon if needed. */
export async function tuiCommand({ args, dataDir, env, io }: CliContext): Promise<number> {
  const parsed = parseTuiArgs(args);
  if ("help" in parsed) {
    io.out(TUI_USAGE);
    return 0;
  }
  if ("error" in parsed) {
    io.err(`hamness: ${parsed.error}`);
    io.err(TUI_USAGE);
    return 2;
  }
  const cwd = process.cwd();
  const cred = await defaultModelCredential({ dataDir, env });
  if (cred.source === "none") {
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
  return runTui({ dataDir, cwd, env, io, ...parsed });
}
