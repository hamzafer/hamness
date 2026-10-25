import { type Env, resolveDataDir } from "../config/paths.ts";
import { VERSION } from "../version.ts";
import { AUDIT_USAGE, auditCommand } from "./commands/audit.ts";
import { COMPAT_USAGE, compatCommand } from "./commands/compat.ts";
import { DAEMON_USAGE, daemonCommand } from "./commands/daemon.ts";
import { DASHBOARD_USAGE, dashboardCommand } from "./commands/dashboard.ts";
import { DOCTOR_USAGE, doctorCommand } from "./commands/doctor.ts";
import { HOOKS_USAGE, hooksCommand } from "./commands/hooks.ts";
import { IMPORT_USAGE, importCommand } from "./commands/import.ts";
import { KEYS_USAGE, keysCommand } from "./commands/keys.ts";
import { LOGIN_USAGE, LOGOUT_USAGE, loginCommand, logoutCommand } from "./commands/login.ts";
import { MODELS_USAGE, modelsCommand } from "./commands/models.ts";
import { STATS_USAGE, statsCommand } from "./commands/stats.ts";
import { STATUS_USAGE, statusCommand } from "./commands/status.ts";
import { STOP_USAGE, stopCommand } from "./commands/stop.ts";
import { TRUST_USAGE, trustCommand } from "./commands/trust.ts";
import { TUI_OPTIONS, TUI_USAGE, tuiCommand } from "./commands/tui.ts";
import { WORKTREES_USAGE, worktreesCommand } from "./commands/worktrees.ts";
import { type CliIo, processIo } from "./io.ts";

export interface CliContext {
  args: string[];
  env: Env;
  dataDir: string;
  io: CliIo;
}

type Command = (ctx: CliContext) => Promise<number>;

interface CommandEntry {
  summary: string;
  usage: string;
  run: Command;
}

/** Every subcommand, in the order `hamness --help` lists them. */
const commands: Record<string, CommandEntry> = {
  tui: {
    summary: "Chat in the terminal (the default with no command)",
    usage: TUI_USAGE,
    run: tuiCommand,
  },
  doctor: {
    summary: "Check the setup: Bun, keys, daemon, data dir, gh, Claude Code",
    usage: DOCTOR_USAGE,
    run: doctorCommand,
  },
  keys: {
    summary: "Optional pay-per-token API keys (set, remove, list)",
    usage: KEYS_USAGE,
    run: keysCommand,
  },
  login: {
    summary: "Sign in to a provider (openai: ChatGPT plan)",
    usage: LOGIN_USAGE,
    run: loginCommand,
  },
  logout: { summary: "Remove a provider sign-in", usage: LOGOUT_USAGE, run: logoutCommand },
  models: {
    summary: "List the models you can use (--all: the whole catalog)",
    usage: MODELS_USAGE,
    run: modelsCommand,
  },
  daemon: {
    summary: "Run the hamness daemon in the foreground",
    usage: DAEMON_USAGE,
    run: daemonCommand,
  },
  status: {
    summary: "Report whether the daemon is running",
    usage: STATUS_USAGE,
    run: statusCommand,
  },
  stop: {
    summary: "Stop the daemon (continue a session with hamness -c)",
    usage: STOP_USAGE,
    run: stopCommand,
  },
  stats: {
    summary: "Summarize sessions, tasks, cost, models and decisions",
    usage: STATS_USAGE,
    run: statsCommand,
  },
  dashboard: {
    summary: "Open the web dashboard (--no-open prints the link)",
    usage: DASHBOARD_USAGE,
    run: dashboardCommand,
  },
  audit: {
    summary: "List recent safety decisions and why they were made",
    usage: AUDIT_USAGE,
    run: auditCommand,
  },
  import: {
    summary: "Import Claude Code and Codex history (read-only)",
    usage: IMPORT_USAGE,
    run: importCommand,
  },
  compat: {
    summary: "Show the Claude Code instructions, skills and MCP servers found here",
    usage: COMPAT_USAGE,
    run: compatCommand,
  },
  trust: {
    summary: "Trust a repo's allow rules, proof commands, hooks and MCP servers",
    usage: TRUST_USAGE,
    run: trustCommand,
  },
  hooks: {
    summary: "List Claude Code hooks (trust: same as `hamness trust`)",
    usage: HOOKS_USAGE,
    run: hooksCommand,
  },
  worktrees: {
    summary: "List subagent worktrees (--prune: remove finished ones)",
    usage: WORKTREES_USAGE,
    run: worktreesCommand,
  },
};

export const COMMAND_NAMES: readonly string[] = Object.keys(commands);

export const USAGE = [
  "Usage: hamness [command] [options]",
  "",
  "With no command, hamness opens a fresh chat in the TUI for the current directory",
  "and starts the daemon if it is not running.",
  "",
  "Commands:",
  ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(10)}${c.summary}`),
  "",
  "`hamness <command> --help` (or `hamness help <command>`) shows a command's options.",
  "",
  "Options:",
  "  -h, --help         Show this help",
  "  -v, --version      Show the version",
  ...TUI_OPTIONS,
  "",
  "Environment:",
  "  HAMNESS_HOME   Data dir (database, token, daemon state)",
  "  HAMNESS_PORT   API port for `hamness daemon` (0 picks a free one)",
  "  HAMNESS_MODEL  Model for new sessions, as provider/id (default: your ChatGPT plan's model)",
  "  HAMNESS_DEBUG  Set to 1 to print stack traces with errors",
  "  CLAUDE_CONFIG_DIR  Claude Code's config dir to read (default ~/.claude)",
  "  ANTHROPIC_API_KEY  Optional Claude API key, pay per token (or `hamness keys set anthropic`)",
  "  OPENAI_API_KEY     Optional OpenAI API key, pay per token; never used by ChatGPT plan models",
].join("\n");

const isHelp = (arg: string | undefined) => arg === "-h" || arg === "--help";

/** Runs the CLI and returns the exit code. */
export async function runCli(
  argv: string[],
  env: Env = process.env,
  io: CliIo = processIo,
): Promise<number> {
  const [first, ...rest] = argv;
  if (isHelp(first) || (first === "help" && rest.length === 0)) {
    io.out(USAGE);
    return 0;
  }
  if (first === "-v" || first === "--version") {
    io.out(VERSION);
    return 0;
  }
  const helpFor = first === "help" ? rest[0] : undefined;
  // `hamness -c`, `hamness -r <id>`: the TUI's own flags.
  const tuiFlags = !helpFor && first?.startsWith("-") === true;
  const name = helpFor ?? (tuiFlags ? "tui" : first) ?? "tui";
  const command = commands[name];
  if (!command) {
    io.err(`hamness: unknown command '${name}'`);
    io.err(USAGE);
    return 2;
  }
  const args = helpFor ? [] : tuiFlags ? argv : rest;
  if (helpFor || isHelp(args[0])) {
    io.out(command.usage);
    return 0;
  }
  try {
    return await command.run({ args, env, dataDir: resolveDataDir(env), io });
  } catch (err) {
    reportCrash(name, err, env, io);
    return 1;
  }
}

/** An error no command handled: one line, plus the stack when HAMNESS_DEBUG is set. */
function reportCrash(name: string, err: unknown, env: Env, io: CliIo): void {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n").find((l) => l.trim()) ?? "unknown error";
  io.err(`hamness ${name}: ${firstLine}`);
  if (env.HAMNESS_DEBUG && err instanceof Error && err.stack) io.err(err.stack);
}
