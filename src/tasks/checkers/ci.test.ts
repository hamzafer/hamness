import { describe, expect, test } from "bun:test";
import { checkContext } from "../../../test/support/check-context.ts";
import type { GhRunner } from "./context.ts";
import { checkCi } from "./ci.ts";

/** A scripted `gh`: answers by the first argument after `gh`, records every call. */
function fakeGh(answers: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
    const a = key ? answers[key] : undefined;
    if (!a) return { exitCode: 1, stdout: "", stderr: "unexpected call" };
    return { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { gh, calls };
}

const prChecks = (checks: Array<{ name: string; bucket: string }>) =>
  JSON.stringify(checks.map((c) => ({ ...c, state: c.bucket.toUpperCase() })));

describe("ci checker, a PR", () => {
  test("passes when every check passed (skipped ones aside)", async () => {
    const { gh, calls } = fakeGh({
      "pr checks": {
        stdout: prChecks([
          { name: "test (macos)", bucket: "pass" },
          { name: "test (linux)", bucket: "pass" },
          { name: "deploy", bucket: "skipping" },
        ]),
      },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, checkContext("/w", { gh }));
    expect(r.status).toBe("passed");
    expect(calls[0]).toEqual(["pr", "checks", "12", "--json", "name,state,bucket"]);
    expect(r.details.counts).toEqual({ pass: 2, fail: 0, pending: 0, skipping: 1 });
  });

  test("fails when a check failed or was cancelled", async () => {
    const { gh } = fakeGh({
      "pr checks": {
        exitCode: 1,
        stdout: prChecks([
          { name: "lint", bucket: "pass" },
          { name: "test", bucket: "fail" },
        ]),
      },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, checkContext("/w", { gh }));
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("test");
  });

  test("fails while checks are still pending", async () => {
    const { gh } = fakeGh({
      "pr checks": { exitCode: 8, stdout: prChecks([{ name: "test", bucket: "pending" }]) },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, checkContext("/w", { gh }));
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("pending");
  });

  test("fails with no checks at all", async () => {
    const { gh } = fakeGh({
      "pr checks": { exitCode: 1, stderr: "no checks reported on the 'x' branch" },
    });
    const r = await checkCi({ kind: "ci", pr: "12" }, checkContext("/w", { gh }));
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("no checks");
  });

  test("passes --repo through, and reports an error when gh cannot run", async () => {
    const { gh, calls } = fakeGh({});
    const r = await checkCi({ kind: "ci", pr: "3", repo: "acme/app" }, checkContext("/w", { gh }));
    expect(calls[0]).toContain("--repo");
    expect(calls[0]).toContain("acme/app");
    expect(r.status).toBe("error");
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

describe("ci checker, a commit", () => {
  const runs = (list: Array<{ name: string; status: string; conclusion: string | null }>) =>
    JSON.stringify({ total_count: list.length, check_runs: list });
  const statuses = (state: string, list: Array<{ context: string; state: string }>) =>
    JSON.stringify({ state, statuses: list });

  test("passes when every check run and status succeeded", async () => {
    const { gh, calls } = fakeGh({
      "check-runs": { stdout: runs([{ name: "ci", status: "completed", conclusion: "success" }]) },
      "/status": { stdout: statuses("success", [{ context: "deploy", state: "success" }]) },
    });
    const r = await checkCi({ kind: "ci", commit: "abc1234" }, checkContext("/w", { gh }));
    expect(r.status).toBe("passed");
    expect(calls[0]).toEqual([
      "api",
      "repos/{owner}/{repo}/commits/abc1234/check-runs?per_page=100",
    ]);
    expect(r.details.counts).toEqual({ pass: 2, fail: 0, pending: 0, skipping: 0 });
  });

  test("fails on a failed run, a running one, or none at all", async () => {
    const failed = fakeGh({
      "check-runs": { stdout: runs([{ name: "ci", status: "completed", conclusion: "failure" }]) },
      "/status": { stdout: statuses("pending", []) },
    });
    expect((await checkCi({ kind: "ci", commit: "abc1234" }, checkContext("/w", failed))).status).toBe(
      "failed",
    );
    const running = fakeGh({
      "check-runs": { stdout: runs([{ name: "ci", status: "in_progress", conclusion: null }]) },
      "/status": { stdout: statuses("pending", []) },
    });
    expect((await checkCi({ kind: "ci", commit: "abc1234" }, checkContext("/w", running))).status).toBe(
      "failed",
    );
    const none = fakeGh({
      "check-runs": { stdout: runs([]) },
      "/status": { stdout: statuses("pending", []) },
    });
    const r = await checkCi({ kind: "ci", commit: "abc1234" }, checkContext("/w", none));
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("no checks");
  });

  test("uses the named repo in the API path", async () => {
    const { gh, calls } = fakeGh({
      "check-runs": { stdout: runs([{ name: "ci", status: "completed", conclusion: "success" }]) },
      "/status": { stdout: statuses("pending", []) },
    });
    await checkCi({ kind: "ci", commit: "abc1234", repo: "acme/app" }, checkContext("/w", { gh }));
    expect(calls[0]?.[1]).toStartWith("repos/acme/app/commits/abc1234/");
  });
});
