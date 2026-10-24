import { type Env, resolveDataDir } from "../config/paths.ts";
import { VERSION } from "../version.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { importCommand } from "./commands/import.ts";
import { keysCommand } from "./commands/keys.ts";
import { loginCommand, logoutCommand } from "./commands/login.ts";
import { modelsCommand } from "./commands/models.ts";
import { statsCommand } from "./commands/stats.ts";
import { statusCommand } from "./commands/status.ts";
import { tuiCommand } from "./commands/tui.ts";
import { type CliIo, processIo } from "./io.ts";

export interface CliContext {
  args: string[];
  env: Env;
  dataDir: string;
  io: CliIo;
}

type Command = (ctx: CliContext) => Promise<number>;

/** Add new subcommands here (tui, stats, audit, import, ...). */
const commands: Record<string, { summary: string; run: Command }> = {
  daemon: { summary: "Run the hamness daemon in the foreground", run: daemonCommand },
  status: { summary: "Report whether the daemon is running", run: statusCommand },
  import: { summary: "Import Claude Code and Codex history (read-only)", run: importCommand },
  stats: { summary: "Summarize sessions, tasks, cost, models and decisions", run: statsCommand },
  tui: { summary: "Chat in the terminal (the default with no command)", run: tuiCommand },
  models: { summary: "List the models you can use (--all: the whole catalog)", run: modelsCommand },
  keys: { summary: "Store API keys (set <provider>, list)", run: keysCommand },
  login: { summary: "Sign in to a provider (openai: ChatGPT plan)", run: loginCommand },
  logout: { summary: "Remove a provider sign-in", run: logoutCommand },
};

export const USAGE = [
  "Usage: hamness [command] [options]",
  "",
  "With no command, hamness opens the chat TUI for the current directory",
  "and starts the daemon if it is not running.",
  "",
  "Commands:",
  ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(10)}${c.summary}`),
  "",
  "Options:",
  "  -h, --help     Show this help",
  "  -v, --version  Show the version",
  "",
  "Environment:",
  "  HAMNESS_HOME   Data dir (database, token, daemon state)",
  "  HAMNESS_PORT   API port for `hamness daemon` (0 picks a free one)",
  "  HAMNESS_MODEL  Model for new sessions, as provider/id (default anthropic/claude-opus-5-5)",
  "  ANTHROPIC_API_KEY  Claude API key (or `hamness keys set anthropic`); env vars win over the key file",
  "  OPENAI_API_KEY     OpenAI API key (or `hamness keys set openai`, or `hamness login openai`)",
].join("\n");

/** Runs the CLI and returns the exit code. */
export async function runCli(
  argv: string[],
  env: Env = process.env,
  io: CliIo = processIo,
): Promise<number> {
  const [name, ...args] = argv;
  if (name === "-h" || name === "--help" || name === "help") {
    io.out(USAGE);
    return 0;
  }
  if (name === "-v" || name === "--version") {
    io.out(VERSION);
    return 0;
  }
  const command = name ? commands[name] : commands.tui;
  if (!command) {
    if (name) io.err(`hamness: unknown command '${name}'`);
    io.err(USAGE);
    return 2;
  }
  return command.run({ args, env, dataDir: resolveDataDir(env), io });
}
