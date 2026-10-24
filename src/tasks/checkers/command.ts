import { spawn } from "node:child_process";
import type { SafetyVerdict } from "../../safety/index.ts";
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
 * Re-runs the agent's command itself, in the session folder, after the same safety check a
 * `bash` call gets. Passes on exit 0 within the timeout. Stores exit code, duration and the
 * redacted output tail.
 */
export async function checkCommand(claim: CommandClaim, ctx: CheckContext): Promise<CheckResult> {
  let verdict: SafetyVerdict;
  try {
    verdict = await ctx.safety({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      tool: "bash",
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
  const run = await runShell(claim.command, ctx.cwd, timeoutMs, ctx.signal);
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

function runShell(
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
    const child = spawn("/bin/sh", ["-c", command], {
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
