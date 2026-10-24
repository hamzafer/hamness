import { spawn } from "node:child_process";
import { redactOutput as redactText } from "../redact.ts";
import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext, GhRunner, GitRunner } from "./context.ts";

type CiClaim = Extract<EvidenceClaim, { kind: "ci" }>;
type Bucket = "pass" | "fail" | "pending" | "skipping";

const GH_TIMEOUT_MS = 60_000;
const MAX_LISTED = 50;

/** Runs the real `gh` with a timeout. */
export const runGh: GhRunner = (args, opts) => run("gh", args, opts);

/** Runs the real `git` with a timeout. */
export const runGit: GitRunner = (args, opts) => run("git", args, opts);

const run = (
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 *
 * The CI must be about this session's work (S-M4): the repo is the session folder's GitHub
 * repo (`gh repo view`), and the code it ran on is in the local history: a commit must be
 * reachable from HEAD; a PR's head branch must be the current branch and its head commit
 * reachable from HEAD. Anything else is an `error`: it is not evidence for this task.
 */
export async function checkCi(claim: CiClaim, ctx: CheckContext): Promise<CheckResult> {
  const target = claim.pr !== undefined ? `PR ${claim.pr}` : `commit ${claim.commit}`;
  const base = { target, ...(claim.repo ? { repo: claim.repo } : {}) };
  const refuse = (summary: string, extra: Record<string, unknown> = {}): CheckResult => ({
    status: "error",
    summary,
    details: { ...base, ...extra },
  });
  let checks: Array<{ name: string; bucket: Bucket }>;
  let links: { prUrl?: string; commitSha?: string } = {};
  try {
    const opts = { cwd: ctx.cwd, timeoutMs: GH_TIMEOUT_MS };
    const repo = await sessionRepo(ctx);
    if (!repo) return refuse(`${target}: could not tell this session's GitHub repo (gh repo view)`);
    const named = claim.repo ?? prUrlRepo(claim.pr);
    if (named && named.toLowerCase() !== repo.toLowerCase()) {
      return refuse(
        `${target}: CI evidence must be for this session's repo (${repo}), not ${named}`,
      );
    }
    const scoped: CiClaim = { ...claim, repo };
    if (claim.pr !== undefined) {
      const head = await prHead(scoped, ctx);
      if ("error" in head) return refuse(`${target}: ${head.error}`);
      const branch = (await ctx.git(["rev-parse", "--abbrev-ref", "HEAD"], opts)).stdout.trim();
      if (head.branch !== branch) {
        return refuse(
          `${target} is for branch ${head.branch}, not the current branch ${branch || "(none)"}`,
        );
      }
      if (!(await inHistory(head.sha, ctx))) {
        return refuse(
          `${target}: its head commit is not in the history of HEAD; pull or push first`,
        );
      }
      links = { prUrl: head.url, commitSha: head.sha };
    } else {
      const full = await ctx.git(
        ["rev-parse", "--verify", "--quiet", `${claim.commit}^{commit}`],
        opts,
      );
      const sha = full.stdout.trim();
      if (full.exitCode !== 0 || !SHA_FULL.test(sha)) {
        return refuse(`${target} is not a commit in this repo`);
      }
      if (!(await inHistory(sha, ctx))) {
        return refuse(`${target} is not in the history of HEAD, so its CI is not about this work`);
      }
      scoped.commit = sha;
      links = { commitSha: sha };
    }
    const got =
      claim.pr !== undefined ? await prChecks(scoped, ctx) : await commitChecks(scoped, ctx);
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
  return {
    status: "passed",
    summary: `${target}: ${counts.pass} check(s) passed`,
    details: { ...details, ...links },
  };
}

const SHA_FULL = /^[0-9a-f]{40}$/i;

/** `owner/name` of the session folder's GitHub repo, or undefined. */
async function sessionRepo(ctx: CheckContext): Promise<string | undefined> {
  const r = await ctx.gh(["repo", "view", "--json", "nameWithOwner"], {
    cwd: ctx.cwd,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) return undefined;
  const name = parse<{ nameWithOwner?: unknown }>(r.stdout)?.nameWithOwner;
  return typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name) ? name : undefined;
}

/** The `owner/name` a PR URL names. */
function prUrlRepo(pr: string | undefined): string | undefined {
  const m = pr?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/);
  return m?.[1];
}

async function prHead(
  claim: CiClaim,
  ctx: CheckContext,
): Promise<{ branch: string; sha: string; url: string } | { error: string }> {
  const args = ["pr", "view", String(claim.pr), "--json", "headRefName,headRefOid,url"];
  if (claim.repo) args.push("--repo", claim.repo);
  const r = await ctx.gh(args, { cwd: ctx.cwd, timeoutMs: GH_TIMEOUT_MS });
  const v = parse<{ headRefName?: unknown; headRefOid?: unknown; url?: unknown }>(r.stdout);
  if (
    r.exitCode !== 0 ||
    !v ||
    typeof v.headRefName !== "string" ||
    typeof v.headRefOid !== "string"
  )
    return { error: `gh pr view failed: ${errorText(r)}` };
  return { branch: v.headRefName, sha: v.headRefOid, url: typeof v.url === "string" ? v.url : "" };
}

async function inHistory(sha: string, ctx: CheckContext): Promise<boolean> {
  const r = await ctx.git(["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: ctx.cwd,
    timeoutMs: GH_TIMEOUT_MS,
  });
  return r.exitCode === 0;
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
