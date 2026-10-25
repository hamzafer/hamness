import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DAY, HOUR, seeder } from "../../test/support/stats-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import {
  decisionsSummary,
  kpis,
  sourceSplit,
  statsReport,
  timeSeries,
  topModels,
  topTools,
  windowFor,
} from "./index.ts";

// 2026-10-24 12:30 UTC. Tests bucket in UTC.
const NOW = Date.UTC(2026, 9, 24, 12, 30);
const q = (range: "today" | "24h" | "7d" | "30d" | "90d", extra = {}) => ({
  range,
  now: NOW,
  utcOffsetMinutes: 0,
  ...extra,
});

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

describe("kpis", () => {
  test("counts sessions that started in the range, by source when asked", () => {
    seed.session({ source: "hamness", at: NOW - HOUR });
    seed.session({ source: "claude-code", at: NOW - 2 * HOUR });
    seed.session({ source: "codex", at: NOW - 3 * DAY });
    seed.session({ source: "codex", at: NOW - 40 * DAY });

    expect(kpis(db.sqlite, q("24h")).sessions).toBe(2);
    expect(kpis(db.sqlite, q("7d")).sessions).toBe(3);
    expect(kpis(db.sqlite, q("90d")).sessions).toBe(4);
    expect(kpis(db.sqlite, q("90d", { source: "codex" })).sessions).toBe(2);
  });

  test("counts tasks by outcome; verified rate is verified over verified + unverified", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    for (const outcome of ["verified", "verified", "verified", "unverified", "abandoned"] as const)
      seed.task({ sessionId: s, at: NOW - HOUR, outcome });
    seed.task({ sessionId: s, at: NOW - HOUR, outcome: "open" });
    seed.task({ sessionId: s, at: NOW - HOUR, outcome: "overridden" });
    seed.task({ sessionId: s, at: NOW - 10 * DAY, outcome: "verified" });

    const k = kpis(db.sqlite, q("7d"));
    expect(k.tasks).toEqual({
      total: 7,
      open: 1,
      verified: 3,
      unverified: 1,
      overridden: 1,
      abandoned: 1,
    });
    // Overridden and abandoned tasks are not in the denominator (ADR 0012).
    expect(k.verifiedRate).toBeCloseTo(3 / 4);
  });

  test("verified rate is null with no closed tasks", () => {
    expect(kpis(db.sqlite, q("7d")).verifiedRate).toBeNull();
  });

  test("verified rate is null when every closed task was overridden or abandoned", () => {
    const s = seed.session({ source: "hamness", at: NOW - DAY });
    seed.task({ sessionId: s, at: NOW - HOUR, outcome: "overridden" });
    seed.task({ sessionId: s, at: NOW - HOUR, outcome: "abandoned" });
    expect(kpis(db.sqlite, q("7d")).verifiedRate).toBeNull();
  });

  test("sums cost and tokens; cost per verified task counts hamness spend only", () => {
    const h = seed.session({ source: "hamness", at: NOW - DAY });
    const t1 = seed.task({ sessionId: h, at: NOW - DAY, outcome: "verified" });
    seed.task({ sessionId: h, at: NOW - DAY, outcome: "verified" });
    seed.task({ sessionId: h, at: NOW - DAY, outcome: "unverified" });
    seed.modelCall({
      sessionId: h,
      taskId: t1,
      at: NOW - DAY,
      model: "claude-opus-5-5",
      input: 100,
      output: 20,
      cacheRead: 1000,
      cacheWrite: 50,
      costMicros: 1_000_000,
    });
    seed.modelCall({
      sessionId: h,
      at: NOW - HOUR,
      model: "claude-opus-5-5",
      input: 10,
      output: 5,
      costMicros: 2_000_000,
    });
    const c = seed.session({ source: "claude-code", at: NOW - DAY });
    seed.modelCall({
      sessionId: c,
      at: NOW - DAY,
      model: "claude-sonnet-5",
      input: 1,
      costMicros: 4_000_000,
    });
    const x = seed.session({ source: "codex", at: NOW - DAY });
    seed.modelCall({ sessionId: x, at: NOW - DAY, model: "llama-local", input: 7, output: 3 });
    seed.modelCall({ sessionId: x, at: NOW - DAY, model: "llama-local", input: 1 });
    seed.modelCall({ sessionId: c, at: NOW - 30 * DAY, model: "claude-sonnet-5", costMicros: 9 });

    const k = kpis(db.sqlite, q("7d"));
    expect(k.modelCalls).toBe(5);
    expect(k.costMicros).toBe(7_000_000);
    expect(k.costPerVerifiedTaskMicros).toBe(1_500_000);
    expect(k.tokens).toEqual({
      input: 119,
      output: 28,
      cacheRead: 1000,
      cacheWrite: 50,
      prompt: 1169,
    });
    expect(k.pricing).toEqual({
      estimated: true,
      unpricedCalls: 2,
      unpricedModels: ["llama-local"],
      planCalls: 0,
    });

    const hamness = kpis(db.sqlite, q("7d", { source: "hamness" }));
    expect(hamness.costMicros).toBe(3_000_000);
    expect(hamness.pricing).toEqual({
      estimated: false,
      unpricedCalls: 0,
      unpricedModels: [],
      planCalls: 0,
    });

    const codex = kpis(db.sqlite, q("7d", { source: "codex" }));
    expect(codex.costPerVerifiedTaskMicros).toBeNull();
    expect(codex.verifiedRate).toBeNull();
  });

  test("sums wall time and active time; active time skips sessions without it", () => {
    seed.session({
      source: "claude-code",
      at: NOW - 5 * HOUR,
      endAt: NOW - 3 * HOUR,
      activeMs: 30 * 60_000,
    });
    seed.session({ source: "codex", at: NOW - 2 * HOUR, endAt: NOW - HOUR, activeMs: null });
    seed.session({ source: "hamness", at: NOW - HOUR, endAt: null });

    const k = kpis(db.sqlite, q("24h"));
    expect(k.wallMs).toBe(3 * HOUR);
    expect(k.activeMs).toBe(30 * 60_000);
    expect(k.activeSessions).toBe(1);
  });

  test("a session's active time never counts for more than its wall time", () => {
    // Imported agents that ran side by side can sum to more than the session lasted.
    seed.session({ source: "codex", at: NOW - 2 * HOUR, endAt: NOW - HOUR, activeMs: 2 * HOUR });
    seed.session({ source: "hamness", at: NOW - 3 * HOUR, endAt: null, activeMs: 10 * 60_000 });
    const k = kpis(db.sqlite, q("24h"));
    expect(k.wallMs).toBe(HOUR);
    expect(k.activeMs).toBe(HOUR + 10 * 60_000);
  });
});

describe("windowFor", () => {
  test("24h is the current hour and the 23 before it", () => {
    const w = windowFor(q("24h"));
    expect(w.from).toBe(Date.UTC(2026, 9, 23, 13));
    expect(w.to).toBe(NOW);
    expect(w.buckets).toBe(24);
  });

  test("today runs from local midnight to now, by hour", () => {
    // UTC+2: local now is 14:30, so today began at 22:00 UTC on the 23rd: 15 hourly buckets.
    const w = windowFor(q("today", { utcOffsetMinutes: 120 }));
    expect(w.from).toBe(Date.UTC(2026, 9, 23, 22));
    expect(w.to).toBe(NOW);
    expect(w.bucketMs).toBe(HOUR);
    expect(w.buckets).toBe(15);
  });

  test("day ranges start at local midnight", () => {
    // UTC+2: local now is 14:30 on the 24th, so today began at 22:00 UTC on the 23rd.
    const w = windowFor(q("7d", { utcOffsetMinutes: 120 }));
    expect(w.from).toBe(Date.UTC(2026, 9, 17, 22));
    expect(w.buckets).toBe(7);
    expect(windowFor(q("30d")).from).toBe(Date.UTC(2026, 8, 25));
  });
});

describe("timeSeries", () => {
  test("buckets calls, cost, tokens and sessions by local day", () => {
    const s = seed.session({ source: "claude-code", at: Date.UTC(2026, 9, 23, 23) });
    seed.modelCall({
      sessionId: s,
      at: Date.UTC(2026, 9, 23, 23),
      model: "m",
      input: 10,
      output: 1,
      costMicros: 5,
    });
    seed.modelCall({
      sessionId: s,
      at: Date.UTC(2026, 9, 24, 12),
      model: "m",
      cacheRead: 100,
      costMicros: 7,
    });
    seed.modelCall({ sessionId: s, at: Date.UTC(2026, 9, 23, 21), model: "m", costMicros: 1 });
    const h = seed.session({ source: "hamness", at: Date.UTC(2026, 9, 20, 9) });
    seed.task({ sessionId: h, at: Date.UTC(2026, 9, 20, 9), outcome: "verified" });

    const series = timeSeries(db.sqlite, q("7d", { utcOffsetMinutes: 120 }));
    expect(series.bucketMs).toBe(DAY);
    expect(series.buckets).toHaveLength(7);
    expect(series.buckets.map((b) => b.costMicros)).toEqual([0, 0, 0, 0, 0, 1, 12]);
    expect(series.buckets.map((b) => b.sessions)).toEqual([0, 0, 1, 0, 0, 0, 1]);
    expect(series.buckets.map((b) => b.tasksVerified)).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(series.buckets[6]).toEqual({
      start: Date.UTC(2026, 9, 23, 22),
      sessions: 1,
      modelCalls: 2,
      costMicros: 12,
      tokens: 111,
      tasks: 0,
      tasksVerified: 0,
    });
  });

  test("24h buckets by hour", () => {
    const s = seed.session({ source: "codex", at: NOW - 30 * HOUR });
    seed.modelCall({ sessionId: s, at: NOW - 5 * 60_000, model: "m", costMicros: 3 });
    seed.modelCall({ sessionId: s, at: NOW - 2 * HOUR, model: "m", costMicros: 4 });
    seed.modelCall({ sessionId: s, at: NOW - 25 * HOUR, model: "m", costMicros: 100 });

    const series = timeSeries(db.sqlite, q("24h"));
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[23]?.costMicros).toBe(3);
    expect(series.buckets[21]?.costMicros).toBe(4);
    expect(series.buckets.reduce((n, b) => n + b.costMicros, 0)).toBe(7);
  });
});

describe("topModels", () => {
  test("ranks models by cost across sources, with calls, tokens and price status", () => {
    const c = seed.session({ source: "claude-code", at: NOW - DAY });
    const x = seed.session({ source: "codex", at: NOW - DAY });
    for (let i = 0; i < 3; i++)
      seed.modelCall({
        sessionId: c,
        at: NOW - HOUR,
        model: "claude-opus-5-5",
        input: 1,
        output: 2,
        costMicros: 10,
      });
    seed.modelCall({
      sessionId: x,
      at: NOW - HOUR,
      model: "claude-opus-5-5",
      cacheRead: 4,
      costMicros: 1,
    });
    seed.modelCall({ sessionId: x, at: NOW - HOUR, model: "gpt-5.6-luna", costMicros: 50 });
    seed.modelCall({ sessionId: x, at: NOW - HOUR, model: "gpt-5.6-luna", costMicros: 50 });
    seed.modelCall({ sessionId: x, at: NOW - HOUR, model: "llama-local", input: 9 });
    seed.modelCall({ sessionId: x, at: NOW - 20 * DAY, model: "old-model" });

    const models = topModels(db.sqlite, q("7d"));
    expect(models.map((m) => [m.model, m.calls, m.costMicros])).toEqual([
      ["gpt-5.6-luna", 2, 100],
      ["claude-opus-5-5", 4, 31],
      ["llama-local", 1, 0],
    ]);
    expect(models[1]?.tokens).toEqual({
      input: 3,
      output: 6,
      cacheRead: 4,
      cacheWrite: 0,
      prompt: 7,
    });
    expect(models[1]?.sources).toEqual(["claude-code", "codex"]);
    expect(models.map((m) => m.priced)).toEqual([true, true, false]);

    expect(topModels(db.sqlite, q("7d"), 1)).toHaveLength(1);
    expect(topModels(db.sqlite, q("7d", { source: "claude-code" })).map((m) => m.calls)).toEqual([
      3,
    ]);
  });
});

describe("topTools", () => {
  test("ranks tools by calls with errors, denials and average duration", () => {
    const c = seed.session({ source: "claude-code", at: NOW - DAY });
    const h = seed.session({ source: "hamness", at: NOW - DAY });
    seed.toolCall({ sessionId: c, at: NOW - HOUR, tool: "Bash", durationMs: 100 });
    seed.toolCall({ sessionId: c, at: NOW - HOUR, tool: "Bash", status: "error", durationMs: 300 });
    seed.toolCall({
      sessionId: h,
      at: NOW - HOUR,
      tool: "Bash",
      status: "denied",
      durationMs: null,
    });
    seed.toolCall({ sessionId: c, at: NOW - HOUR, tool: "Read", durationMs: 5 });
    seed.toolCall({ sessionId: c, at: NOW - 9 * DAY, tool: "Edit" });

    expect(topTools(db.sqlite, q("7d"))).toEqual([
      { tool: "Bash", calls: 3, errors: 1, denied: 1, avgDurationMs: 200 },
      { tool: "Read", calls: 1, errors: 0, denied: 0, avgDurationMs: 5 },
    ]);
    expect(topTools(db.sqlite, q("7d", { source: "hamness" }))).toEqual([
      { tool: "Bash", calls: 1, errors: 0, denied: 1, avgDurationMs: null },
    ]);
  });
});

describe("decisionsSummary", () => {
  test("is all zeros with no decisions", () => {
    expect(decisionsSummary(db.sqlite, q("7d"))).toEqual({
      total: 0,
      allow: 0,
      ask: 0,
      deny: 0,
      bySource: [],
      judge: { decisions: 0, avgLatencyMs: null, costMicros: 0 },
    });
  });

  test("counts verdicts by decision source; the judge row adds latency and cost", () => {
    const h = seed.session({ source: "hamness", at: NOW - DAY });
    seed.decision({ sessionId: h, at: NOW - HOUR, verdict: "allow", source: "rule" });
    seed.decision({ sessionId: h, at: NOW - HOUR, verdict: "deny", source: "rule" });
    seed.decision({
      sessionId: h,
      at: NOW - HOUR,
      verdict: "allow",
      source: "judge",
      latencyMs: 100,
      costMicros: 20,
    });
    seed.decision({
      sessionId: h,
      at: NOW - HOUR,
      verdict: "ask",
      source: "judge",
      latencyMs: 300,
      costMicros: 30,
    });
    seed.decision({
      sessionId: null,
      at: NOW - HOUR,
      verdict: "allow",
      source: "judge",
      latencyMs: 200,
      costMicros: 10,
    });
    seed.decision({ sessionId: h, at: NOW - 10 * DAY, verdict: "deny", source: "user" });

    const d = decisionsSummary(db.sqlite, q("7d"));
    expect(d).toEqual({
      total: 5,
      allow: 3,
      ask: 1,
      deny: 1,
      bySource: [
        { source: "judge", total: 3, allow: 2, ask: 1, deny: 0 },
        { source: "rule", total: 2, allow: 1, ask: 0, deny: 1 },
      ],
      judge: { decisions: 3, avgLatencyMs: 200, costMicros: 60 },
    });
    // Decisions without a session belong to no source.
    expect(decisionsSummary(db.sqlite, q("7d", { source: "hamness" })).total).toBe(4);
    expect(decisionsSummary(db.sqlite, q("7d", { source: "codex" })).total).toBe(0);
  });
});

describe("sourceSplit", () => {
  test("gives every source a row, zeros included", () => {
    const c = seed.session({
      source: "claude-code",
      at: NOW - DAY,
      endAt: NOW - DAY + HOUR,
      activeMs: 60_000,
    });
    seed.session({ source: "claude-code", at: NOW - 2 * DAY });
    seed.modelCall({
      sessionId: c,
      at: NOW - DAY,
      model: "m",
      input: 5,
      output: 5,
      costMicros: 40,
    });
    const h = seed.session({ source: "hamness", at: NOW - DAY });
    seed.task({ sessionId: h, at: NOW - DAY, outcome: "verified" });
    seed.task({ sessionId: h, at: NOW - DAY, outcome: "open" });

    expect(sourceSplit(db.sqlite, q("7d"))).toEqual([
      {
        source: "hamness",
        sessions: 1,
        modelCalls: 0,
        costMicros: 0,
        tokens: 0,
        tasks: 2,
        verified: 1,
        wallMs: 0,
        activeMs: 0,
      },
      {
        source: "claude-code",
        sessions: 2,
        modelCalls: 1,
        costMicros: 40,
        tokens: 10,
        tasks: 0,
        verified: 0,
        wallMs: HOUR,
        activeMs: 60_000,
      },
      {
        source: "codex",
        sessions: 0,
        modelCalls: 0,
        costMicros: 0,
        tokens: 0,
        tasks: 0,
        verified: 0,
        wallMs: 0,
        activeMs: 0,
      },
    ]);
    expect(sourceSplit(db.sqlite, q("7d", { source: "codex" })).map((r) => r.source)).toEqual([
      "codex",
    ]);
  });
});

describe("statsReport", () => {
  test("bundles every query for one range", () => {
    const c = seed.session({ source: "claude-code", at: NOW - HOUR });
    seed.modelCall({ sessionId: c, at: NOW - HOUR, model: "claude-opus-5-5", costMicros: 9 });
    seed.toolCall({ sessionId: c, at: NOW - HOUR, tool: "Read" });

    const r = statsReport(db.sqlite, q("24h"));
    expect(r.range).toBe("24h");
    expect(r.source).toBeNull();
    expect(r.from).toBe(Date.UTC(2026, 9, 23, 13));
    expect(r.to).toBe(NOW);
    expect(r.kpis.costMicros).toBe(9);
    expect(r.series.buckets).toHaveLength(24);
    expect(r.models.map((m) => m.model)).toEqual(["claude-opus-5-5"]);
    expect(r.tools.map((t) => t.tool)).toEqual(["Read"]);
    expect(r.decisions.total).toBe(0);
    expect(r.sources.map((x) => x.sessions)).toEqual([0, 1, 0]);
  });
});
