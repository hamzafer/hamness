import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const MAIN = resolve(import.meta.dir, "../../src/cli/main.ts");
const MCP_SERVER = resolve(import.meta.dir, "mcp-server.ts");

export interface DaemonProcess {
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  readonly pid: number;
  readonly url: string;
  readonly token: string;
  readonly dataDir: string;
  /** Resolves true once the process has exited, false if it is still alive after `ms`. */
  exitsWithin(ms: number): Promise<boolean>;
  /** SIGKILLs it if it is still alive (afterEach). */
  kill(): Promise<void>;
}

export interface SpawnDaemonOptions {
  /** A Claude Code config dir with a user MCP server (the test echo server) in it. */
  mcp?: boolean;
  /** Extra env for the daemon. */
  env?: Record<string, string>;
}

/**
 * Runs `hamness daemon --port 0` as a real child process on `dataDir`, the way `ensureDaemon`
 * starts it, and waits until it serves. Its env is minimal: a temp HOME and Claude Code dir,
 * so it never reads the developer's own setup.
 */
export async function spawnDaemon(
  dataDir: string,
  opts: SpawnDaemonOptions = {},
): Promise<DaemonProcess> {
  const home = join(dataDir, "..", `home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  if (opts.mcp) {
    writeFileSync(
      join(claude, ".claude.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [MCP_SERVER] } } }),
    );
  }
  const proc = Bun.spawn([process.execPath, "--config=/dev/null", MAIN, "daemon", "--port", "0"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      HAMNESS_HOME: dataDir,
      // As `ensureDaemon` starts it, so a scan can find it.
      HAMNESS_DAEMON: "1",
      CLAUDE_CONFIG_DIR: claude,
      // No plan login here, so name a model or attaching is "not set up". No prompt is sent.
      HAMNESS_MODEL: "anthropic/claude-haiku-5-5",
      ...opts.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const statePath = join(dataDir, "daemon.json");
  const deadline = Date.now() + 10_000;
  let url: string | undefined;
  while (Date.now() < deadline && proc.exitCode === null) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number; url?: string };
        if (state.pid === proc.pid && state.url) {
          url = state.url;
          break;
        }
      } catch {
        // Half-written: try again.
      }
    }
    await Bun.sleep(20);
  }
  if (!url) {
    proc.kill("SIGKILL");
    const err = await new Response(proc.stderr).text();
    throw new Error(`the test daemon did not start: ${err}`);
  }
  const token = readFileSync(join(dataDir, "token"), "utf8").trim();
  const exitsWithin = async (ms: number) =>
    (await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(ms).then(() => false),
    ])) as boolean;
  return {
    proc,
    pid: proc.pid,
    url,
    token,
    dataDir,
    exitsWithin,
    async kill() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

/**
 * A stand-in for a daemon that stopped serving but never exited: a process whose command line
 * is `bun <dir>/main.ts daemon` with HAMNESS_HOME set to `dataDir`, which serves nothing and,
 * with `ignoreSigterm`, survives SIGTERM (as the stray daemons did). `marker: false` leaves out
 * the HAMNESS_DAEMON env `ensureDaemon` sets; `hamnessHome` overrides HAMNESS_HOME. Not a daemon,
 * so the test controls exactly how it dies.
 */
export async function spawnStray(
  dataDir: string,
  opts: { ignoreSigterm?: boolean; marker?: boolean; hamnessHome?: string } = {},
): Promise<Subprocess<"ignore", "pipe", "pipe">> {
  // A space in the path, as in macOS's "Application Support".
  const dir = join(dataDir, "..", `stray dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "main.ts");
  writeFileSync(
    script,
    [
      opts.ignoreSigterm ? `process.on("SIGTERM", () => {});` : "",
      "setInterval(() => {}, 1000);",
      `console.log("ready");`,
    ].join("\n"),
  );
  const proc = Bun.spawn([process.execPath, "--config=/dev/null", script, "daemon"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      HAMNESS_HOME: opts.hamnessHome ?? dataDir,
      ...(opts.marker === false ? {} : { HAMNESS_DAEMON: "1" }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for its handlers, so a SIGTERM never lands before it ignores them.
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return proc;
}

/** The pids of `pid`'s direct children, or only those whose command line matches `pattern`. */
export function childPids(pid: number, pattern?: string): number[] {
  const args = ["pgrep", "-P", String(pid), ...(pattern ? ["-f", pattern] : [])];
  const out = Bun.spawnSync(args).stdout.toString();
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Polls until `pid` runs the test MCP server as a child; resolves with the server's pid. */
export async function waitForMcpServer(pid: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const kids = childPids(pid, "mcp-server.ts");
    if (kids[0] !== undefined) return kids[0];
    await Bun.sleep(25);
  }
  throw new Error(`pid ${pid} started no MCP server`);
}
