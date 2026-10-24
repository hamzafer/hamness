import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DAY, HOUR, seeder } from "../../test/support/stats-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import { type StatsQuery, statsReport } from "../stats/index.ts";
import { renderStats } from "./commands/stats.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

beforeEach(() => {
  home = tempHome();
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

const dataDir = () => join(home.dir, "data");
const env = () => ({ HAMNESS_HOME: dataDir() });

/** A small synthetic history: a bit of every source, relative to `now`. */
function seedHistory(now: number) {
  mkdirSync(dataDir(), { recursive: true });
  const db = openDatabase(join(dataDir(), "hamness.sqlite"));
  const seed = seeder(db.sqlite);
  const h = seed.session({ source: "hamness", at: now - 2 * HOUR, endAt: now - HOUR });
  const t = seed.task({ sessionId: h, at: now - 2 * HOUR, outcome: "verified" });
  seed.task({ sessionId: h, at: now - 2 * HOUR, outcome: "unverified" });
  seed.task({ sessionId: h, at: now - 3 * DAY, outcome: "verified" });
  seed.modelCall({
    sessionId: h,
    taskId: t,
    at: now - 2 * HOUR,
    model: "claude-opus-5-5",
    input: 12_000,
    output: 3_000,
    cacheRead: 250_000,
    costMicros: 1_250_000,
  });
  seed.decision({ sessionId: h, at: now - 2 * HOUR, verdict: "allow", source: "rule" });
  seed.decision({
    sessionId: h,
    at: now - 2 * HOUR,
    verdict: "deny",
    source: "judge",
    latencyMs: 420,
    costMicros: 300,
  });
  seed.toolCall({ sessionId: h, at: now - 2 * HOUR, tool: "bash", durationMs: 1500 });

  const c = seed.session({
    source: "claude-code",
    at: now - 4 * DAY,
    endAt: now - 4 * DAY + 3 * HOUR,
    activeMs: 50 * 60_000,
  });
  for (let i = 0; i < 4; i++)
    seed.modelCall({
      sessionId: c,
      at: now - 4 * DAY,
      model: "claude-sonnet-5",
      input: 2_000,
      output: 800,
      cacheRead: 40_000,
      cacheWrite: 5_000,
      costMicros: 310_000,
    });
  seed.toolCall({ sessionId: c, at: now - 4 * DAY, tool: "Read", durationMs: 20 });
  seed.toolCall({
    sessionId: c,
    at: now - 4 * DAY,
    tool: "Bash",
    status: "error",
    durationMs: 900,
  });
  seed.toolCall({ sessionId: c, at: now - 4 * DAY, tool: "Read", durationMs: 40 });

  const x = seed.session({ source: "codex", at: now - 20 * DAY, endAt: now - 20 * DAY + HOUR });
  seed.modelCall({
    sessionId: x,
    at: now - 20 * DAY,
    model: "gpt-5.6-luna",
    input: 900,
    costMicros: 2_000,
  });
  seed.modelCall({ sessionId: x, at: now - 20 * DAY, model: "local-llm", input: 500, output: 100 });
  db.close();
}

const NOW = Date.UTC(2026, 9, 24, 12, 30);

function reportsAt(now: number, ranges: StatsQuery["range"][], source?: StatsQuery["source"]) {
  const db = openDatabase(join(dataDir(), "hamness.sqlite"));
  try {
    return ranges.map((range) =>
      statsReport(db.sqlite, { range, source, now, utcOffsetMinutes: 0 }),
    );
  } finally {
    db.close();
  }
}

describe("renderStats", () => {
  test("today, 7 days and 30 days side by side, details for 7 days", () => {
    seedHistory(NOW);
    const reports = reportsAt(NOW, ["24h", "7d", "30d"]);
    const text = renderStats(reports, 1);
    expect(text).toMatchSnapshot();
    expect(text).not.toContain("—");
  });

  test("one range and one source", () => {
    seedHistory(NOW);
    const text = renderStats(reportsAt(NOW, ["30d"], "codex"), 0);
    expect(text).toMatchSnapshot();
  });

  test("leaves out the outcome breakdown while there are no tasks", () => {
    seedHistory(NOW);
    const text = renderStats(reportsAt(NOW - 4 * DAY + HOUR, ["24h"]), 0);
    expect(text).toContain("Tasks");
    expect(text).not.toContain("unverified");
  });

  test("an empty database says there is nothing yet", () => {
    seedHistory(NOW);
    const text = renderStats(reportsAt(NOW + 400 * DAY, ["7d"]), 0);
    expect(text).toContain("Nothing recorded in the last 7 days.");
  });
});

describe("hamness stats", () => {
  test("prints the summary", async () => {
    seedHistory(Date.now());
    const code = await runCli(["stats"], env(), io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Top models");
    expect(text).toContain("claude-sonnet-5");
  });

  test("--json prints one report per range", async () => {
    seedHistory(Date.now());
    const code = await runCli(
      ["stats", "--json", "--range", "30d", "--source", "codex"],
      env(),
      io,
    );
    expect(code).toBe(0);
    const json = JSON.parse(out.join("\n"));
    expect(json.reports).toHaveLength(1);
    expect(json.reports[0].range).toBe("30d");
    expect(json.reports[0].source).toBe("codex");
    expect(json.reports[0].kpis.modelCalls).toBe(2);
  });

  test("with no database it says so and creates nothing", async () => {
    const code = await runCli(["stats"], env(), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("No data yet");
  });

  test("a bad range or source is a usage error", async () => {
    expect(await runCli(["stats", "--range", "1y"], env(), io)).toBe(2);
    expect(await runCli(["stats", "--source", "cursor"], env(), io)).toBe(2);
    expect(err.join("\n")).toContain("Usage: hamness stats");
  });
});
