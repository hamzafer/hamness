import { spawn } from "node:child_process";
import type { SafetyVerdict } from "../../safety/index.ts";
import { PROVE_COMMAND } from "../../safety/proof.ts";
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
  return {
    status: passed ? "passed" : "failed",
    summary: `exit ${run.exitCode ?? `signal ${run.signal}`} in ${durationMs}ms`,
    details,
  };
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
