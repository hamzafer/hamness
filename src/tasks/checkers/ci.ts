import { spawn } from "node:child_process";
import { redactOutput as redactText } from "../redact.ts";
import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext, GhRunner } from "./context.ts";

type CiClaim = Extract<EvidenceClaim, { kind: "ci" }>;
type Bucket = "pass" | "fail" | "pending" | "skipping";

const GH_TIMEOUT_MS = 60_000;
const MAX_LISTED = 50;

/** Runs the real `gh` with a timeout. */
export const runGh: GhRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

/**
 * Reads CI status itself through `gh`. A PR: `gh pr checks`. A commit: its check runs and
 * commit statuses. Passes when at least one check passed and none failed or is still pending.
 */
export async function checkCi(claim: CiClaim, ctx: CheckContext): Promise<CheckResult> {
  const target = claim.pr !== undefined ? `PR ${claim.pr}` : `commit ${claim.commit}`;
  const base = { target, ...(claim.repo ? { repo: claim.repo } : {}) };
  let checks: Array<{ name: string; bucket: Bucket }>;
  try {
    const got =
      claim.pr !== undefined ? await prChecks(claim, ctx) : await commitChecks(claim, ctx);
    if ("error" in got) {
      return got.noChecks
        ? {
            status: "failed",
            summary: `${target}: no checks reported`,
            details: { ...base, counts: tally([]) },
          }
        : {
            status: "error",
            summary: `${target}: gh failed: ${got.error}`,
            details: { ...base, error: got.error },
          };
    }
    checks = got.checks;
  } catch (err) {
    const error = redactText((err as Error).message);
    return { status: "error", summary: `could not run gh: ${error}`, details: { ...base, error } };
  }

  const counts = tally(checks);
  const details = { ...base, counts, checks: checks.slice(0, MAX_LISTED) };
  if (checks.length === 0)
    return { status: "failed", summary: `${target}: no checks reported`, details };
  if (counts.fail > 0) {
    const names = checks.filter((c) => c.bucket === "fail").map((c) => c.name);
    return {
      status: "failed",
      summary: `${target}: failed: ${names.slice(0, 5).join(", ")}`,
      details,
    };
  }
  if (counts.pending > 0) {
    return {
      status: "failed",
      summary: `${target}: ${counts.pending} check(s) still pending`,
      details,
    };
  }
  if (counts.pass === 0)
    return { status: "failed", summary: `${target}: no check passed`, details };
  return { status: "passed", summary: `${target}: ${counts.pass} check(s) passed`, details };
}

function tally(checks: Array<{ bucket: Bucket }>): Record<Bucket, number> {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0 };
  for (const c of checks) counts[c.bucket] += 1;
  return counts;
}

type Got =
  | { checks: Array<{ name: string; bucket: Bucket }> }
  | { error: string; noChecks?: boolean };

function parse<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

function errorText(r: { stdout: string; stderr: string; exitCode: number }): string {
  const text = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
  return redactText(text || `exit ${r.exitCode}`).slice(0, 300);
}

async function prChecks(claim: CiClaim, ctx: CheckContext): Promise<Got> {
  const args = ["pr", "checks", String(claim.pr), "--json", "name,state,bucket"];
  if (claim.repo) args.push("--repo", claim.repo);
  // Exit 1 (a check failed) and 8 (pending) still print the JSON.
  const r = await ctx.gh(args, { cwd: ctx.cwd, timeoutMs: GH_TIMEOUT_MS });
  const list = parse<Array<{ name?: string; bucket?: string }>>(r.stdout);
  if (!Array.isArray(list)) {
    const error = errorText(r);
    return { error, noChecks: /no checks reported/i.test(error) };
  }
  return {
    checks: list.map((c) => ({
      name: String(c.name ?? "?"),
      bucket:
        c.bucket === "pass" || c.bucket === "pending" || c.bucket === "skipping"
          ? c.bucket
          : "fail",
    })),
  };
}

async function commitChecks(claim: CiClaim, ctx: CheckContext): Promise<Got> {
  const repo = claim.repo ?? "{owner}/{repo}";
  const opts = { cwd: ctx.cwd, timeoutMs: GH_TIMEOUT_MS };
  const runsRes = await ctx.gh(
    ["api", `repos/${repo}/commits/${claim.commit}/check-runs?per_page=100`],
    opts,
  );
  const runs = parse<{
    check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
  }>(runsRes.stdout);
  if (runsRes.exitCode !== 0 || !runs || !Array.isArray(runs.check_runs))
    return { error: errorText(runsRes) };
  const statusRes = await ctx.gh(["api", `repos/${repo}/commits/${claim.commit}/status`], opts);
  const combined = parse<{ statuses?: Array<{ context?: string; state?: string }> }>(
    statusRes.stdout,
  );
  if (statusRes.exitCode !== 0 || !combined) return { error: errorText(statusRes) };

  const checks: Array<{ name: string; bucket: Bucket }> = runs.check_runs.map((run) => ({
    name: String(run.name ?? "?"),
    bucket:
      run.status !== "completed"
        ? "pending"
        : run.conclusion === "success"
          ? "pass"
          : run.conclusion === "skipped" || run.conclusion === "neutral"
            ? "skipping"
            : "fail",
  }));
  for (const s of combined.statuses ?? []) {
    checks.push({
      name: String(s.context ?? "?"),
      bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail",
    });
  }
  return { checks };
}
