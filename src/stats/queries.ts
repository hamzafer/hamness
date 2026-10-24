import type { Database } from "bun:sqlite";
import { priceFor } from "../models/prices.ts";
import { SOURCES, type Source, type StatsQuery, type Window, windowFor } from "./window.ts";

type Params = [number, number, string | null];
const params = (w: Window): Params => [w.from, w.to, w.source];

export interface TaskCounts {
  total: number;
  open: number;
  verified: number;
  unverified: number;
  overridden: number;
  abandoned: number;
}

export interface Tokens {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Whole prompt: input + cacheRead + cacheWrite. */
  prompt: number;
}

export interface Pricing {
  /** True when imported calls are in the totals: their cost is estimated from token counts. */
  estimated: boolean;
  /** Calls of models with no known price. They count as $0. */
  unpricedCalls: number;
  unpricedModels: string[];
}

export interface Kpis {
  sessions: number;
  tasks: TaskCounts;
  /** verified / closed tasks (every outcome but `open`). Null with no closed tasks. */
  verifiedRate: number | null;
  modelCalls: number;
  costMicros: number;
  /**
   * hamness spend over verified tasks (all of it, so failed work counts against the rate).
   * Imported history has no tasks, so its spend is left out. Null with no verified tasks.
   */
  costPerVerifiedTaskMicros: number | null;
  tokens: Tokens;
  pricing: Pricing;
  /** Sum of first-to-last event time over sessions with both ends known. */
  wallMs: number;
  /** Sum of active time over the sessions that record it (`activeSessions`). */
  activeMs: number;
  activeSessions: number;
}

interface ModelSourceRow {
  source: Source;
  model: string;
  calls: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Model calls grouped by source, model and time bucket `b`. */
interface ModelFact extends ModelSourceRow {
  b: number;
}

/**
 * One window over one handle. The model-call scan, the heavy part, runs at
 * most once however many views read it, so a whole report scans once.
 */
interface Ctx {
  sqlite: Database;
  w: Window;
  p: Params;
  facts(): ModelFact[];
}

function context(sqlite: Database, q: StatsQuery): Ctx {
  const w = windowFor(q);
  const p = params(w);
  let facts: ModelFact[] | undefined;
  return {
    sqlite,
    w,
    p,
    facts: () => {
      facts ??= sqlite
        .query<ModelFact, [...Params, number]>(
          `SELECT s.source, mc.model, (mc.created_at - ?1) / ?4 AS b, count(*) AS calls,
             sum(mc.cost_micros) AS cost, sum(mc.input_tokens) AS input,
             sum(mc.output_tokens) AS output, sum(mc.cache_read_tokens) AS cacheRead,
             sum(mc.cache_write_tokens) AS cacheWrite
           FROM model_calls mc JOIN sessions s ON s.id = mc.session_id
           WHERE mc.created_at BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
           GROUP BY s.source, mc.model, b`,
        )
        .all(...p, w.bucketMs);
      return facts;
    },
  };
}

/** Model-call facts summed over time: one row per source and model. */
function modelSourceRows(c: Ctx): ModelSourceRow[] {
  const rows = new Map<string, ModelSourceRow>();
  for (const f of c.facts()) {
    const key = `${f.source}\0${f.model}`;
    const r = rows.get(key);
    if (!r) {
      const { b: _bucket, ...row } = f;
      rows.set(key, row);
      continue;
    }
    r.calls += f.calls;
    r.cost += f.cost;
    r.input += f.input;
    r.output += f.output;
    r.cacheRead += f.cacheRead;
    r.cacheWrite += f.cacheWrite;
  }
  return [...rows.values()];
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompt: 0 });

function addTokens(t: Tokens, r: Omit<Tokens, "prompt">): void {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.prompt += r.input + r.cacheRead + r.cacheWrite;
}

/** A model with no price and no recorded cost: its calls count as $0. */
const unpriced = (model: string, cost: number) => cost === 0 && priceFor(model) === undefined;

export function kpis(sqlite: Database, q: StatsQuery): Kpis {
  return kpisOf(context(sqlite, q));
}

function kpisOf(c: Ctx): Kpis {
  const { sqlite, p } = c;
  const s = sqlite
    .query<{ n: number; wall: number | null; active: number | null; activeN: number }, Params>(
      `SELECT count(*) AS n,
         sum(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
             THEN max(0, ended_at - started_at) END) AS wall,
         sum(active_ms) AS active, count(active_ms) AS activeN
       FROM sessions
       WHERE coalesce(started_at, created_at) BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR source = ?3)`,
    )
    .get(...p);

  const tasks: TaskCounts = {
    total: 0,
    open: 0,
    verified: 0,
    unverified: 0,
    overridden: 0,
    abandoned: 0,
  };
  const rows = sqlite
    .query<{ outcome: keyof TaskCounts; n: number }, Params>(
      `SELECT t.outcome, count(*) AS n FROM tasks t JOIN sessions s ON s.id = t.session_id
       WHERE coalesce(t.started_at, t.created_at) BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR s.source = ?3)
       GROUP BY t.outcome`,
    )
    .all(...p);
  for (const r of rows) {
    tasks[r.outcome] = r.n;
    tasks.total += r.n;
  }
  const closed = tasks.total - tasks.open;

  let modelCalls = 0;
  let costMicros = 0;
  let hamnessCost = 0;
  const tokens = emptyTokens();
  const pricing: Pricing = { estimated: false, unpricedCalls: 0, unpricedModels: [] };
  const unpricedByModel = new Map<string, number>();
  for (const r of modelSourceRows(c)) {
    modelCalls += r.calls;
    costMicros += r.cost;
    if (r.source === "hamness") hamnessCost += r.cost;
    else pricing.estimated = true;
    addTokens(tokens, r);
    if (unpriced(r.model, r.cost)) {
      pricing.unpricedCalls += r.calls;
      unpricedByModel.set(r.model, (unpricedByModel.get(r.model) ?? 0) + r.calls);
    }
  }
  pricing.unpricedModels = [...unpricedByModel].sort((a, b) => b[1] - a[1]).map(([m]) => m);

  return {
    sessions: s?.n ?? 0,
    tasks,
    verifiedRate: closed > 0 ? tasks.verified / closed : null,
    modelCalls,
    costMicros,
    costPerVerifiedTaskMicros: tasks.verified > 0 ? Math.round(hamnessCost / tasks.verified) : null,
    tokens,
    pricing,
    wallMs: s?.wall ?? 0,
    activeMs: s?.active ?? 0,
    activeSessions: s?.activeN ?? 0,
  };
}

export interface Bucket {
  /** Bucket start (ms). */
  start: number;
  sessions: number;
  modelCalls: number;
  costMicros: number;
  /** Prompt plus output tokens. */
  tokens: number;
  tasks: number;
  tasksVerified: number;
}

export interface TimeSeries {
  bucketMs: number;
  /** Every bucket of the range in order, empty ones included. */
  buckets: Bucket[];
}

type BucketParams = [number, number, string | null, number];

/** One bucket per hour (today, 24h) or local day (7d, 30d, 90d). */
export function timeSeries(sqlite: Database, q: StatsQuery): TimeSeries {
  return timeSeriesOf(context(sqlite, q));
}

function timeSeriesOf(c: Ctx): TimeSeries {
  const { sqlite, w } = c;
  const p: BucketParams = [w.from, w.to, w.source, w.bucketMs];
  const buckets: Bucket[] = Array.from({ length: w.buckets }, (_, i) => ({
    start: w.from + i * w.bucketMs,
    sessions: 0,
    modelCalls: 0,
    costMicros: 0,
    tokens: 0,
    tasks: 0,
    tasksVerified: 0,
  }));
  const at = (i: number) => buckets[i];

  for (const f of c.facts()) {
    const b = at(f.b);
    if (!b) continue;
    b.modelCalls += f.calls;
    b.costMicros += f.cost;
    b.tokens += f.input + f.output + f.cacheRead + f.cacheWrite;
  }

  for (const r of sqlite
    .query<{ b: number; n: number }, BucketParams>(
      `SELECT (coalesce(started_at, created_at) - ?1) / ?4 AS b, count(*) AS n FROM sessions
       WHERE coalesce(started_at, created_at) BETWEEN ?1 AND ?2 AND (?3 IS NULL OR source = ?3)
       GROUP BY b`,
    )
    .all(...p)) {
    const b = at(r.b);
    if (b) b.sessions = r.n;
  }

  for (const r of sqlite
    .query<{ b: number; n: number; verified: number }, BucketParams>(
      `SELECT (coalesce(t.started_at, t.created_at) - ?1) / ?4 AS b, count(*) AS n,
         sum(t.outcome = 'verified') AS verified
       FROM tasks t JOIN sessions s ON s.id = t.session_id
       WHERE coalesce(t.started_at, t.created_at) BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
       GROUP BY b`,
    )
    .all(...p)) {
    const b = at(r.b);
    if (!b) continue;
    b.tasks = r.n;
    b.tasksVerified = r.verified;
  }

  return { bucketMs: w.bucketMs, buckets };
}

export interface ModelRow {
  model: string;
  calls: number;
  costMicros: number;
  tokens: Tokens;
  sources: Source[];
  /** False when the model has no known price and its calls count as $0. */
  priced: boolean;
}

/** Models by number of calls (then cost), grouped by the model id as stored. */
export function topModels(sqlite: Database, q: StatsQuery, limit = 5): ModelRow[] {
  return topModelsOf(context(sqlite, q), limit);
}

function topModelsOf(c: Ctx, limit: number): ModelRow[] {
  const byModel = new Map<string, ModelRow>();
  for (const r of modelSourceRows(c)) {
    let m = byModel.get(r.model);
    if (!m) {
      m = {
        model: r.model,
        calls: 0,
        costMicros: 0,
        tokens: emptyTokens(),
        sources: [],
        priced: true,
      };
      byModel.set(r.model, m);
    }
    m.calls += r.calls;
    m.costMicros += r.cost;
    addTokens(m.tokens, r);
    m.sources.push(r.source);
  }
  const rows = [...byModel.values()];
  for (const m of rows) {
    m.priced = !unpriced(m.model, m.costMicros);
    m.sources.sort();
  }
  return rows
    .sort(
      (a, b) => b.calls - a.calls || b.costMicros - a.costMicros || a.model.localeCompare(b.model),
    )
    .slice(0, limit);
}

export interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  denied: number;
  /** Over calls with a known duration. Null when none has one. */
  avgDurationMs: number | null;
}

/** Tools by number of calls. */
export function topTools(sqlite: Database, q: StatsQuery, limit = 5): ToolRow[] {
  return topToolsOf(context(sqlite, q), limit);
}

function topToolsOf({ sqlite, p }: Ctx, limit: number): ToolRow[] {
  return sqlite
    .query<ToolRow, [...Params, number]>(
      `SELECT tc.tool, count(*) AS calls, sum(tc.status = 'error') AS errors,
         sum(tc.status = 'denied') AS denied, CAST(round(avg(tc.duration_ms)) AS INTEGER) AS avgDurationMs
       FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
       WHERE tc.created_at BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
       GROUP BY tc.tool ORDER BY calls DESC, tc.tool LIMIT ?4`,
    )
    .all(...p, limit);
}

export type DecisionSource = "rule" | "judge" | "hook" | "user" | "mode";

export interface VerdictCounts {
  total: number;
  allow: number;
  ask: number;
  deny: number;
}

export interface DecisionsSummary extends VerdictCounts {
  /** One row per decision source that decided anything, most decisions first. */
  bySource: (VerdictCounts & { source: DecisionSource })[];
  judge: { decisions: number; avgLatencyMs: number | null; costMicros: number };
}

/**
 * Safety decisions (the audit log) in the range. Decisions without a session
 * count only when no source filter is set.
 */
export function decisionsSummary(sqlite: Database, q: StatsQuery): DecisionsSummary {
  return decisionsOf(context(sqlite, q));
}

function decisionsOf({ sqlite, p }: Ctx): DecisionsSummary {
  const rows = sqlite
    .query<
      VerdictCounts & { source: DecisionSource; latency: number | null; cost: number },
      Params
    >(
      `SELECT d.source, count(*) AS total, sum(d.verdict = 'allow') AS allow,
         sum(d.verdict = 'ask') AS ask, sum(d.verdict = 'deny') AS deny,
         avg(d.latency_ms) AS latency, sum(d.cost_micros) AS cost
       FROM decisions d LEFT JOIN sessions s ON s.id = d.session_id
       WHERE d.created_at BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
       GROUP BY d.source ORDER BY total DESC, d.source`,
    )
    .all(...p);
  const out: DecisionsSummary = {
    total: 0,
    allow: 0,
    ask: 0,
    deny: 0,
    bySource: [],
    judge: { decisions: 0, avgLatencyMs: null, costMicros: 0 },
  };
  for (const { latency, cost, ...r } of rows) {
    out.total += r.total;
    out.allow += r.allow;
    out.ask += r.ask;
    out.deny += r.deny;
    out.bySource.push(r);
    if (r.source === "judge") {
      out.judge = {
        decisions: r.total,
        avgLatencyMs: latency === null ? null : Math.round(latency),
        costMicros: cost,
      };
    }
  }
  return out;
}

export interface SourceRow {
  source: Source;
  sessions: number;
  modelCalls: number;
  costMicros: number;
  /** Prompt plus output tokens. */
  tokens: number;
  tasks: number;
  verified: number;
  wallMs: number;
  activeMs: number;
}

/** One row per source (hamness, claude-code, codex), or just the filtered one. */
export function sourceSplit(sqlite: Database, q: StatsQuery): SourceRow[] {
  return sourceSplitOf(context(sqlite, q));
}

function sourceSplitOf(c: Ctx): SourceRow[] {
  const { sqlite, w, p } = c;
  const rows = new Map<Source, SourceRow>();
  for (const source of SOURCES) {
    if (w.source && w.source !== source) continue;
    rows.set(source, {
      source,
      sessions: 0,
      modelCalls: 0,
      costMicros: 0,
      tokens: 0,
      tasks: 0,
      verified: 0,
      wallMs: 0,
      activeMs: 0,
    });
  }
  for (const r of sqlite
    .query<{ source: Source; n: number; wall: number | null; active: number | null }, Params>(
      `SELECT source, count(*) AS n,
         sum(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
             THEN max(0, ended_at - started_at) END) AS wall,
         sum(active_ms) AS active
       FROM sessions
       WHERE coalesce(started_at, created_at) BETWEEN ?1 AND ?2 AND (?3 IS NULL OR source = ?3)
       GROUP BY source`,
    )
    .all(...p)) {
    const row = rows.get(r.source);
    if (!row) continue;
    row.sessions = r.n;
    row.wallMs = r.wall ?? 0;
    row.activeMs = r.active ?? 0;
  }
  for (const r of modelSourceRows(c)) {
    const row = rows.get(r.source);
    if (!row) continue;
    row.modelCalls += r.calls;
    row.costMicros += r.cost;
    row.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
  }
  for (const r of sqlite
    .query<{ source: Source; n: number; verified: number }, Params>(
      `SELECT s.source, count(*) AS n, sum(t.outcome = 'verified') AS verified
       FROM tasks t JOIN sessions s ON s.id = t.session_id
       WHERE coalesce(t.started_at, t.created_at) BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.source = ?3)
       GROUP BY s.source`,
    )
    .all(...p)) {
    const row = rows.get(r.source);
    if (!row) continue;
    row.tasks = r.n;
    row.verified = r.verified;
  }
  return [...rows.values()];
}

export interface StatsReport {
  range: StatsQuery["range"];
  source: Source | null;
  from: number;
  to: number;
  kpis: Kpis;
  series: TimeSeries;
  models: ModelRow[];
  tools: ToolRow[];
  decisions: DecisionsSummary;
  sources: SourceRow[];
}

/** Everything `hamness stats --json` prints and the dashboard draws, for one range. */
export function statsReport(
  sqlite: Database,
  q: StatsQuery,
  opts: { models?: number; tools?: number } = {},
): StatsReport {
  const c = context(sqlite, q);
  return {
    range: q.range,
    source: c.w.source,
    from: c.w.from,
    to: c.w.to,
    kpis: kpisOf(c),
    series: timeSeriesOf(c),
    models: topModelsOf(c, opts.models ?? 5),
    tools: topToolsOf(c, opts.tools ?? 5),
    decisions: decisionsOf(c),
    sources: sourceSplitOf(c),
  };
}
