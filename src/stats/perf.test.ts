import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DAY } from "../../test/support/stats-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import { RANGES, statsReport } from "./index.ts";

/*
 * A large synthetic history: 100k model calls, 40k tool calls, 2k sessions,
 * 3k tasks and 5k decisions over 120 days. A whole report must stay fast.
 */
const NOW = Date.UTC(2026, 9, 24, 12);
const SPAN = 120 * DAY;
const MODELS = ["claude-opus-5-5", "claude-sonnet-5", "gpt-5.6-luna", "gpt-5.6-terra", "local-x"];
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "Task"];
const SOURCES = ["hamness", "claude-code", "codex"] as const;
const OUTCOMES = ["open", "verified", "unverified", "overridden", "abandoned"] as const;

// A fixed-seed PRNG so the data is the same on every run.
function rng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;

beforeAll(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  const r = rng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
  const s = db.sqlite;
  const ins = {
    session: s.prepare(
      `INSERT INTO sessions (id, source, cwd, started_at, ended_at, active_ms, created_at, updated_at)
       VALUES (?, ?, 'app', ?, ?, ?, ?, ?)`,
    ),
    task: s.prepare(
      `INSERT INTO tasks (id, session_id, goal, outcome, started_at, created_at, updated_at)
       VALUES (?, ?, 'g', ?, ?, ?, ?)`,
    ),
    model: s.prepare(
      `INSERT INTO model_calls (id, session_id, task_id, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_micros, created_at, updated_at)
       VALUES (?, ?, ?, 'p', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    tool: s.prepare(
      `INSERT INTO tool_calls (id, session_id, tool, status, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    decision: s.prepare(
      `INSERT INTO decisions (id, session_id, tool, verdict, source, latency_ms, cost_micros, created_at, updated_at)
       VALUES (?, ?, 'Bash', ?, ?, ?, ?, ?, ?)`,
    ),
  };
  s.transaction(() => {
    const sessions: { id: string; at: number; source: string; tasks: string[] }[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = NOW - Math.floor(r() * SPAN);
      const id = Bun.randomUUIDv7();
      const source = pick(SOURCES);
      ins.session.run(id, source, at, at + 3_600_000, Math.floor(r() * 3_600_000), at, at);
      sessions.push({ id, at, source, tasks: [] });
    }
    for (let i = 0; i < 3000; i++) {
      const sess = pick(sessions.filter((x) => x.source === "hamness"));
      const id = Bun.randomUUIDv7();
      ins.task.run(id, sess.id, pick(OUTCOMES), sess.at, sess.at, sess.at);
      sess.tasks.push(id);
    }
    for (let i = 0; i < 100_000; i++) {
      const sess = pick(sessions);
      const at = sess.at + Math.floor(r() * 3_600_000);
      const task = sess.tasks.length ? pick(sess.tasks) : null;
      const input = Math.floor(r() * 5000);
      ins.model.run(
        Bun.randomUUIDv7(),
        sess.id,
        task,
        pick(MODELS),
        input,
        Math.floor(r() * 2000),
        Math.floor(r() * 50_000),
        Math.floor(r() * 2000),
        Math.floor(r() * 50_000),
        at,
        at,
      );
    }
    for (let i = 0; i < 40_000; i++) {
      const sess = pick(sessions);
      const at = sess.at + Math.floor(r() * 3_600_000);
      ins.tool.run(
        Bun.randomUUIDv7(),
        sess.id,
        pick(TOOLS),
        r() < 0.1 ? "error" : "ok",
        Math.floor(r() * 5000),
        at,
        at,
      );
    }
    for (let i = 0; i < 5000; i++) {
      const sess = pick(sessions);
      const at = sess.at + Math.floor(r() * 3_600_000);
      ins.decision.run(
        Bun.randomUUIDv7(),
        sess.id,
        pick(["allow", "ask", "deny"]),
        pick(["rule", "judge", "user"]),
        Math.floor(r() * 500),
        Math.floor(r() * 100),
        at,
        at,
      );
    }
  })();
  s.run("ANALYZE");
});

afterAll(() => {
  db.close();
  home.cleanup();
});

/**
 * The time budget for one report. The target is about 200 ms on a laptop; the budget leaves
 * room for slower machines (CI runners twice as much), and `HAMNESS_PERF_BUDGET_MS` tunes it.
 */
const BUDGET_MS = Number(process.env.HAMNESS_PERF_BUDGET_MS) || (process.env.CI ? 800 : 400);
const RUNS = 5;

/** The median time of `RUNS` reports after a warm-up: one GC pause or busy core can't fail it. */
function medianMs(run: () => unknown): number {
  run(); // warm the statement cache
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)] as number;
}

describe("stats on a large database", () => {
  for (const range of RANGES) {
    test(`a full ${range} report stays fast`, () => {
      const q = { range, now: NOW, utcOffsetMinutes: 0 };
      const report = statsReport(db.sqlite, q);
      expect(report.kpis.modelCalls).toBeGreaterThan(0);
      const ms = medianMs(() => statsReport(db.sqlite, q));
      if (process.env.HAMNESS_PERF) console.log(`${range}: median ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(BUDGET_MS);
    }, 30_000);
  }

  test("a source filter stays fast too", () => {
    const q = { range: "90d" as const, source: "codex" as const, now: NOW, utcOffsetMinutes: 0 };
    const ms = medianMs(() => statsReport(db.sqlite, q));
    if (process.env.HAMNESS_PERF) console.log(`90d codex: median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
