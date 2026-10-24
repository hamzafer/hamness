import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SafetyVerdict } from "../../safety/index.ts";
import { PROVE_COMMAND } from "../../safety/proof.ts";
import { parseCommand } from "../../safety/shell.ts";
import { hasPipe } from "../proof-shape.ts";
import { redactOutput } from "../redact.ts";
import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext } from "./context.ts";

export const DEFAULT_COMMAND_TIMEOUT_S = 300;
/** Characters of output kept (after redaction). */
export const OUTPUT_TAIL = 4000;
/** Characters buffered while the command runs; older output is dropped as it streams. */
const BUFFER = 64_000;

type CommandClaim = Extract<EvidenceClaim, { kind: "command" }>;

/**
 * Re-runs the agent's command itself, in the session folder, after its safety check as a
 * proof re-run (`prove_command`, ADR 0019: bash's deny / ask rules plus the proof command
 * list). Passes on exit 0 within the timeout, unless the output shows that no tests ran.
 * A command with a pipe runs under bash's `pipefail`, so `bun test | tail` fails when the
 * tests do. Stores exit code, duration and the redacted output tail.
 */
export async function checkCommand(claim: CommandClaim, ctx: CheckContext): Promise<CheckResult> {
  let verdict: SafetyVerdict;
  try {
    verdict = await ctx.safety({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      tool: PROVE_COMMAND,
      args: { command: claim.command },
      cwd: ctx.cwd,
    });
  } catch (err) {
    verdict = { allow: false, reason: `safety check failed: ${(err as Error).message}` };
  }
  if (!verdict.allow) {
    return {
      status: "error",
      summary: `not run: blocked by safety (${verdict.reason})`,
      details: { command: claim.command, blocked: verdict.reason },
    };
  }

  const timeoutMs = (claim.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S) * 1000;
  const started = performance.now();
  const shell = shellFor(claim.command);
  if (!shell) {
    return {
      status: "error",
      summary: "not run: a command with a pipe needs bash (for pipefail), and none was found",
      details: { command: claim.command },
    };
  }
  const run = await runShell(shell, claim.command, ctx.cwd, timeoutMs, ctx.signal);
  const durationMs = Math.round(performance.now() - started);
  const outputTail = redactOutput(run.output).slice(-OUTPUT_TAIL);
  const details = {
    command: claim.command,
    exitCode: run.exitCode,
    durationMs,
    timedOut: run.timedOut,
    outputTail,
  };
  if (run.aborted) return { status: "error", summary: "aborted before it finished", details };
  if (run.spawnError) {
    return { status: "error", summary: `could not run: ${run.spawnError}`, details };
  }
  if (run.timedOut) {
    return { status: "failed", summary: `timed out after ${timeoutMs / 1000}s`, details };
  }
  const passed = run.exitCode === 0;
  if (passed && noTestsRan(run.output)) {
    return { status: "failed", summary: "exit 0, but no tests ran", details };
  }
  const summary = `exit ${run.exitCode ?? `signal ${run.signal}`} in ${durationMs}ms`;
  const changed = passed ? changedConfig(claim.command, ctx) : [];
  if (changed.length > 0) {
    const weakReason = `the agent changed ${changed.join(", ")} in this task, which defines what the command runs`;
    return {
      status: "passed",
      summary: `${summary} (weak: ${weakReason}, so it does not verify alone)`,
      details: { ...details, weak: true, weakReason },
    };
  }
  return { status: passed ? "passed" : "failed", summary, details };
}

/**
 * Files that decide what a test, build or lint command runs (V-H1): its scripts, its runner's
 * config, its build manifest. A pass after the agent edited one of them is weak evidence.
 */
const CONFIG_FILE =
  /^(?:package\.json|bunfig\.toml|[Mm]akefile|GNUmakefile|.+\.mk|conftest\.py|pytest\.ini|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|noxfile\.py|(?:jest|vitest|vitest\.workspace|playwright|karma|cypress|ava|webpack|vite|rollup|babel)\.config\.[cm]?[jt]sx?(?:on)?|\.mocharc.*|\.babelrc.*|Cargo\.toml|build\.rs|go\.mod|\.eslintrc.*|eslint\.config\.[cm]?[jt]s|tsconfig.*\.json|jsconfig.*\.json|biome\.jsonc?|deno\.jsonc?|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|mix\.exs|Rakefile|\.rspec|justfile|Justfile|Taskfile\.ya?ml)$/;

/** Flags whose value is a file the command loads or runs: `--preload x`, `-exec=x`, `-c x`. */
const FILE_FLAGS = new Set([
  "--preload",
  "-r",
  "--require",
  "--import",
  "--loader",
  "-exec",
  "--exec",
  "-toolexec",
  "--config",
  "-c",
  "--config-path",
  "--rcfile",
  "-p",
  "--project",
  "-f",
  "--file",
  "--makefile",
  "--setupFiles",
  "--setup-files",
  "--globalSetup",
  "--rootdir",
  "--confcutdir",
]);

/** The agent-written files (by its write / edit tools) that define what `command` runs. */
function changedConfig(command: string, ctx: CheckContext): string[] {
  const written = ctx.writtenPaths?.();
  if (!written || written.size === 0) return [];
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const named = new Set<string>();
  const parsed = parseCommand(command.trim());
  let dir = ctx.cwd;
  for (const seg of parsed.ok ? parsed.segments : []) {
    const [head, ...rest] = seg.words;
    if (head === "cd" && rest[0]) {
      dir = resolve(dir, rest[0]);
      continue;
    }
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] as string;
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      if (!FILE_FLAGS.has(flag)) continue;
      const value = eq > 0 ? w.slice(eq + 1) : rest[i + 1];
      if (value && !value.startsWith("-")) {
        named.add(resolve(dir, value));
        named.add(real(resolve(dir, value)));
      }
    }
  }
  const out = new Set<string>();
  for (const path of written) {
    if (CONFIG_FILE.test(basename(path)) || named.has(path) || named.has(real(path))) {
      out.add(basename(path));
    }
  }
  return [...out].sort();
}

interface ShellRun {
  exitCode: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

/**
 * Test runners that exit 0 without running a test say so. `cargo test` prints one
 * `running N tests` line per target, so it counts only when every one is 0.
 */
const NO_TESTS = [
  /\bRan 0 tests\b/,
  /\bno tests to run\b/,
  /\bNo tests? (files )?found\b/i,
  /\bno tests ran\b/i,
];

export function noTestsRan(output: string): boolean {
  if (NO_TESTS.some((re) => re.test(output))) return true;
  const cargo = [...output.matchAll(/^running (\d+) tests?$/gm)].map((m) => Number(m[1]));
  return cargo.length > 0 && cargo.every((n) => n === 0);
}

/** `/bin/sh -c`, or bash with pipefail when the command has a pipe. Undefined: no bash. */
function shellFor(command: string): string[] | undefined {
  if (!hasPipe(command)) return ["/bin/sh", "-c"];
  const bash = Bun.which("bash");
  return bash ? [bash, "-o", "pipefail", "-c"] : undefined;
}

function runShell(
  shell: string[],
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ShellRun> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let aborted = false;
    // Its own process group, so a timeout kills the command's children too.
    const [bin = "/bin/sh", ...flags] = shell;
    const child = spawn(bin, [...flags, command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > BUFFER) output = output.slice(-BUFFER);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (r: Partial<ShellRun>) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, signal: null, output, timedOut, aborted, ...r });
    };
    child.on("error", (err) => finish({ spawnError: err.message }));
    child.on("close", (code, sig) => finish({ exitCode: code, signal: sig }));
  });
}
