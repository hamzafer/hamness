import { describe, expect, test } from "bun:test";
import { checkContext } from "../../../test/support/check-context.ts";
import { checkCi } from "./ci.ts";
import type { GhRunner, GitRunner } from "./context.ts";

type Answer = { exitCode?: number; stdout?: string; stderr?: string };

/** A scripted command: answers by the first key its arguments contain, records every call. */
function scripted(answers: Record<string, Answer>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
    const a = key ? answers[key] : undefined;
    if (!a) return { exitCode: 1, stdout: "", stderr: "unexpected call" };
    return { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

const SHA = `abc1234${"0".repeat(33)}`;

/** The session's repo is acme/app on branch feature, with SHA in HEAD's history. */
function world(gh: Record<string, Answer>, git: Record<string, Answer> = {}) {
  const g = scripted({
    "repo view": { stdout: JSON.stringify({ nameWithOwner: "acme/app" }) },
    "pr view": {
      stdout: JSON.stringify({
        headRefName: "feature",
        headRefOid: SHA,
        url: "https://github.com/acme/app/pull/12",
      }),
    },
    ...gh,
  });
  const r = scripted({
    "--abbrev-ref": { stdout: "feature\n" },
    "rev-parse --verify": { stdout: `${SHA}\n` },
    "merge-base --is-ancestor": { exitCode: 0 },
    ...git,
  });
  return {
    ctx: checkContext("/w", { gh: g.run as GhRunner, git: r.run as GitRunner }),
    gh: g.calls,
    git: r.calls,
  };
}

const prChecks = (checks: Array<{ name: string; bucket: string }>) =>
  JSON.stringify(checks.map((c) => ({ ...c, state: c.bucket.toUpperCase() })));

describe("ci checker, a PR", () => {
  test("passes when every check passed (skipped ones aside), and links the PR and commit", async () => {
    const w = world({
      "pr checks": {
        stdout: prChecks([
          { name: "test (macos)", bucket: "pass" },
          { name: "test (linux)", bucket: "pass" },
          { name: "deploy", bucket: "skipping" },
        ]),
      },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, w.ctx);
    expect(r.status).toBe("passed");
    expect(w.gh.find((c) => c[1] === "checks")).toEqual([
      "pr",
      "checks",
      "12",
      "--json",
      "name,state,bucket",
      "--repo",
      "acme/app",
    ]);
    expect(r.details.counts).toEqual({ pass: 2, fail: 0, pending: 0, skipping: 1 });
    expect(r.details.prUrl).toBe("https://github.com/acme/app/pull/12");
    expect(r.details.commitSha).toBe(SHA);
  });

  test("fails when a check failed or was cancelled", async () => {
    const w = world({
      "pr checks": {
        exitCode: 1,
        stdout: prChecks([
          { name: "lint", bucket: "pass" },
          { name: "test", bucket: "fail" },
        ]),
      },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, w.ctx);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("test");
  });

  test("fails while checks are still pending, or with none at all", async () => {
    const pending = world({
      "pr checks": { exitCode: 8, stdout: prChecks([{ name: "test", bucket: "pending" }]) },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, pending.ctx);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("pending");
    const none = world({
      "pr checks": { exitCode: 1, stderr: "no checks reported on the 'x' branch" },
    });
    const n = await checkCi({ kind: "ci", pr: "12" }, none.ctx);
    expect(n.status).toBe("failed");
    expect(n.summary).toContain("no checks");
  });

  test("reports an error when gh cannot run", async () => {
    const broken = await checkCi(
      { kind: "ci", pr: "3" },
      checkContext("/w", {
        gh: async () => {
          throw new Error("spawn gh ENOENT");
        },
      }),
    );
    expect(broken.status).toBe("error");
    expect(broken.summary).toContain("ENOENT");
  });
});

describe("ci evidence must be about this session's work (S-M4)", () => {
  const green = { "pr checks": { stdout: prChecks([{ name: "ci", bucket: "pass" }]) } };

  test("another repo is refused, by repo field or PR URL, and gh never asked for its checks", async () => {
    for (const claim of [
      { kind: "ci" as const, pr: "3", repo: "someone/else" },
      { kind: "ci" as const, pr: "https://github.com/someone/else/pull/3" },
      { kind: "ci" as const, commit: "abc1234", repo: "someone/else" },
    ]) {
      const w = world(green);
      const r = await checkCi(claim, w.ctx);
      expect(r.status).toBe("error");
      expect(r.summary).toContain("acme/app");
      expect(w.gh.some((c) => c[1] === "checks" || c[0] === "api")).toBe(false);
    }
    // The same repo named in another case is fine.
    const same = world(green);
    expect((await checkCi({ kind: "ci", pr: "12", repo: "Acme/App" }, same.ctx)).status).toBe(
      "passed",
    );
  });

  test("a PR for another branch, or whose head is not in local history, is refused", async () => {
    const other = world({
      ...green,
      "pr view": {
        stdout: JSON.stringify({ headRefName: "main", headRefOid: SHA, url: "u" }),
      },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, other.ctx);
    expect(r.status).toBe("error");
    expect(r.summary).toContain("current branch");
    const ahead = world(green, { "merge-base --is-ancestor": { exitCode: 1 } });
    const a = await checkCi({ kind: "ci", pr: "12" }, ahead.ctx);
    expect(a.status).toBe("error");
    expect(a.summary).toContain("history");
  });

  test("a commit must be in HEAD's history", async () => {
    const outside = world({}, { "merge-base --is-ancestor": { exitCode: 1 } });
    const r = await checkCi({ kind: "ci", commit: "abc1234" }, outside.ctx);
    expect(r.status).toBe("error");
    expect(r.summary).toContain("history");
    const unknown = world({}, { "rev-parse --verify": { exitCode: 1 } });
    expect((await checkCi({ kind: "ci", commit: "abc1234" }, unknown.ctx)).status).toBe("error");
  });
});

describe("ci checker, a commit", () => {
  const runs = (list: Array<{ name: string; status: string; conclusion: string | null }>) =>
    JSON.stringify({ total_count: list.length, check_runs: list });
  const statuses = (state: string, list: Array<{ context: string; state: string }>) =>
    JSON.stringify({ state, statuses: list });

  test("passes when every check run and status succeeded, using the full sha", async () => {
    const w = world({
      "check-runs": { stdout: runs([{ name: "ci", status: "completed", conclusion: "success" }]) },
      "/status": { stdout: statuses("success", [{ context: "deploy", state: "success" }]) },
    });
    const r = await checkCi({ kind: "ci", commit: "abc1234" }, w.ctx);
    expect(r.status).toBe("passed");
    expect(w.gh.find((c) => c[0] === "api")).toEqual([
      "api",
      `repos/acme/app/commits/${SHA}/check-runs?per_page=100`,
    ]);
    expect(r.details.counts).toEqual({ pass: 2, fail: 0, pending: 0, skipping: 0 });
    expect(r.details.commitSha).toBe(SHA);
  });

  test("fails on a failed run, a running one, or none at all", async () => {
    for (const [list, word] of [
      [[{ name: "ci", status: "completed", conclusion: "failure" }], "failed"],
      [[{ name: "ci", status: "in_progress", conclusion: null }], "pending"],
      [[], "no checks"],
    ] as const) {
      const w = world({
        "check-runs": { stdout: runs([...list]) },
        "/status": { stdout: statuses("pending", []) },
      });
      const r = await checkCi({ kind: "ci", commit: "abc1234" }, w.ctx);
      expect(r.status).toBe("failed");
      expect(r.summary).toContain(word);
    }
  });
});
