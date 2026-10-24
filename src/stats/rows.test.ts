import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DAY, HOUR, seeder } from "../../test/support/stats-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import { listDecisions, listTasks, taskEvidence } from "./index.ts";

// 2026-10-24 12:30 UTC. Tests bucket in UTC.
const NOW = Date.UTC(2026, 9, 24, 12, 30);
const base = { now: NOW, utcOffsetMinutes: 0 };

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;
let seed: ReturnType<typeof seeder>;

beforeEach(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  seed = seeder(db.sqlite);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

describe("listTasks", () => {
  test("one row per task with its cost, tokens, time and evidence counts", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const t = seed.task({
      sessionId: s,
      at: NOW - 3 * HOUR,
      endAt: NOW - 2 * HOUR,
      outcome: "verified",
      goal: "fix the parser",
    });
    seed.modelCall({
      sessionId: s,
      taskId: t,
      at: NOW - 3 * HOUR,
      model: "m",
      input: 100,
      output: 20,
      cacheRead: 1000,
      costMicros: 400_000,
    });
    seed.modelCall({
      sessionId: s,
      taskId: t,
      at: NOW - 2 * HOUR,
      model: "m",
      costMicros: 100_000,
    });
    seed.modelCall({ sessionId: s, at: NOW - 2 * HOUR, model: "m", costMicros: 9_000_000 });
    seed.evidence({ taskId: t, at: NOW - 2 * HOUR, status: "passed" });
    seed.evidence({ taskId: t, at: NOW - 2 * HOUR, status: "failed" });
    seed.evidence({ taskId: t, at: NOW - 2 * HOUR, status: "pending" });

    const page = listTasks(db.sqlite, { ...base, range: "7d" });
    expect(page.nextCursor).toBeNull();
    expect(page.rows).toEqual([
      {
        id: t,
        sessionId: s,
        source: "hamness",
        goal: "fix the parser",
        implicit: false,
        outcome: "verified",
        reason: null,
        summary: null,
        costMicros: 500_000,
        tokens: 1120,
        startedAt: NOW - 3 * HOUR,
        endedAt: NOW - 2 * HOUR,
        durationMs: HOUR,
        evidence: { checked: 2, passed: 1, pending: 1 },
        branch: null,
        commitSha: null,
        prUrl: null,
      },
    ]);
  });

  test("a task links to its branch, commit and PR (P-L4)", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    seed.task({
      sessionId: s,
      at: NOW - HOUR,
      outcome: "verified",
      branch: "feature/parser",
      commitSha: "abc1234",
      prUrl: "https://github.com/acme/app/pull/7",
    });
    expect(listTasks(db.sqlite, { ...base, range: "7d" }).rows[0]).toMatchObject({
      branch: "feature/parser",
      commitSha: "abc1234",
      prUrl: "https://github.com/acme/app/pull/7",
    });
  });

  test("an open task runs until now", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    seed.task({ sessionId: s, at: NOW - 2 * HOUR, outcome: "open" });
    const [row] = listTasks(db.sqlite, { ...base, range: "24h" }).rows;
    expect(row?.endedAt).toBeNull();
    expect(row?.durationMs).toBe(2 * HOUR);
  });

  test("range, source and outcome filters narrow the rows; newest first", () => {
    const h = seed.session({ source: "hamness", at: NOW - 40 * DAY });
    const c = seed.session({ source: "claude-code", at: NOW - 40 * DAY });
    const a = seed.task({ sessionId: h, at: NOW - HOUR, outcome: "verified" });
    const b = seed.task({ sessionId: h, at: NOW - 2 * DAY, outcome: "unverified" });
    const old = seed.task({ sessionId: h, at: NOW - 40 * DAY, outcome: "verified" });
    const cc = seed.task({ sessionId: c, at: NOW - 3 * HOUR, outcome: "abandoned" });

    const ids = (q: Parameters<typeof listTasks>[1]) =>
      listTasks(db.sqlite, q).rows.map((r) => r.id);
    expect(ids({ ...base, range: "24h" })).toEqual([a, cc]);
    expect(ids({ ...base, range: "7d" })).toEqual([a, cc, b]);
    expect(ids({ ...base, range: "90d" })).toEqual([a, cc, b, old]);
    expect(ids({ ...base, range: "90d", source: "hamness" })).toEqual([a, b, old]);
    expect(ids({ ...base, range: "90d", outcome: "verified" })).toEqual([a, old]);
  });

  test("pages with a cursor until the last page", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const made = [1, 2, 3, 4, 5].map((i) =>
      seed.task({ sessionId: s, at: NOW - i * HOUR, outcome: "verified" }),
    );
    // Two tasks at the same instant still page in a stable order.
    const twin = seed.task({ sessionId: s, at: NOW - 5 * HOUR, outcome: "verified" });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = listTasks(db.sqlite, { ...base, range: "7d", limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set([...made, twin]));
    expect(seen.slice(0, 4)).toEqual(made.slice(0, 4));
  });

  test("a malformed cursor is an error", () => {
    expect(() => listTasks(db.sqlite, { ...base, range: "7d", cursor: "nope" })).toThrow(/cursor/);
  });

  test("turn tasks are marked implicit and can be left out", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const turn = seed.task({ sessionId: s, at: NOW - HOUR, outcome: "unverified", implicit: true });
    const real = seed.task({ sessionId: s, at: NOW - 2 * HOUR, outcome: "verified" });
    const rows = listTasks(db.sqlite, { ...base, range: "24h" }).rows;
    expect(rows.map((r) => [r.id, r.implicit])).toEqual([
      [turn, true],
      [real, false],
    ]);
    const explicit = listTasks(db.sqlite, { ...base, range: "24h", turns: false }).rows;
    expect(explicit.map((r) => r.id)).toEqual([real]);
  });

  test("carries the override or abandon reason", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    seed.task({ sessionId: s, at: NOW - HOUR, outcome: "overridden", reason: "checked by hand" });
    expect(listTasks(db.sqlite, { ...base, range: "24h" }).rows[0]?.reason).toBe("checked by hand");
  });
});

describe("taskEvidence", () => {
  test("lists a task's evidence with the claim and the checker's one-line summary", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const t = seed.task({ sessionId: s, at: NOW - HOUR, outcome: "verified" });
    const e1 = seed.evidence({
      taskId: t,
      at: NOW - HOUR,
      claim: { kind: "command", command: "bun test" },
      status: "passed",
      summary: "bun test exited 0",
    });
    const e2 = seed.evidence({
      taskId: t,
      at: NOW - HOUR + 1,
      kind: "file",
      claim: { kind: "file", path: "src/a.ts" },
      status: "pending",
    });

    expect(taskEvidence(db.sqlite, t)).toEqual([
      {
        id: e1,
        kind: "command",
        claim: "bun test",
        status: "passed",
        summary: "bun test exited 0",
        createdAt: NOW - HOUR,
        checkedAt: NOW - HOUR,
      },
      {
        id: e2,
        kind: "file",
        claim: "src/a.ts",
        status: "pending",
        summary: null,
        createdAt: NOW - HOUR + 1,
        checkedAt: null,
      },
    ]);
  });

  test("an unknown task has no evidence", () => {
    expect(taskEvidence(db.sqlite, "nope")).toEqual([]);
  });
});

describe("listDecisions", () => {
  test("one row per decision with who decided, why and the session's source", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const d = seed.decision({
      sessionId: s,
      at: NOW - HOUR,
      tool: "bash",
      verdict: "deny",
      source: "rule",
      reason: "rm -rf is never allowed",
      rule: "default: bash rm -rf *",
      latencyMs: 2,
    });
    expect(listDecisions(db.sqlite, { ...base, range: "24h" })).toEqual({
      rows: [
        {
          id: d,
          sessionId: s,
          sessionSource: "hamness",
          tool: "bash",
          verdict: "deny",
          decidedBy: "rule",
          reason: "rm -rf is never allowed",
          rule: "default: bash rm -rf *",
          latencyMs: 2,
          costMicros: 0,
          createdAt: NOW - HOUR,
        },
      ],
      nextCursor: null,
    });
  });

  test("filters by range, source, verdict and decider; sessionless rows only unfiltered", () => {
    const h = seed.session({ source: "hamness", at: NOW - DAY });
    const c = seed.session({ source: "claude-code", at: NOW - DAY });
    const a = seed.decision({ sessionId: h, at: NOW - HOUR, verdict: "allow", source: "rule" });
    const b = seed.decision({ sessionId: h, at: NOW - 2 * HOUR, verdict: "deny", source: "judge" });
    const x = seed.decision({ sessionId: c, at: NOW - 3 * HOUR, verdict: "ask", source: "hook" });
    const none = seed.decision({ at: NOW - 4 * HOUR, verdict: "deny", source: "mode" });
    const old = seed.decision({
      sessionId: h,
      at: NOW - 3 * DAY,
      verdict: "allow",
      source: "user",
    });

    const ids = (q: Parameters<typeof listDecisions>[1]) =>
      listDecisions(db.sqlite, q).rows.map((r) => r.id);
    expect(ids({ ...base, range: "24h" })).toEqual([a, b, x, none]);
    expect(ids({ ...base, range: "7d" })).toEqual([a, b, x, none, old]);
    expect(ids({ ...base, range: "7d", source: "hamness" })).toEqual([a, b, old]);
    expect(ids({ ...base, range: "7d", verdict: "deny" })).toEqual([b, none]);
    expect(ids({ ...base, range: "7d", decidedBy: "judge" })).toEqual([b]);
  });

  test("pages with a cursor", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    const made = [1, 2, 3].map((i) =>
      seed.decision({ sessionId: s, at: NOW - i * HOUR, verdict: "allow", source: "rule" }),
    );
    const first = listDecisions(db.sqlite, { ...base, range: "24h", limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(made.slice(0, 2));
    const cursor = first.nextCursor ?? undefined;
    expect(cursor).toBeDefined();
    const second = listDecisions(db.sqlite, { ...base, range: "24h", limit: 2, cursor });
    expect(second.rows.map((r) => r.id)).toEqual(made.slice(2));
    expect(second.nextCursor).toBeNull();
  });
});
