import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { dataPaths } from "../../config/paths.ts";
import { openDatabase } from "../../db/open.ts";
import {
  RANGES,
  type Range,
  SOURCES,
  type Source,
  type StatsReport,
  statsReport,
} from "../../stats/index.ts";
import type { CliContext } from "../run.ts";

export const STATS_USAGE = [
  "Usage: hamness stats [--range 24h|7d|30d|90d] [--source hamness|claude-code|codex] [--json]",
  "",
  "Sessions, tasks, verified rate, cost, models, tools and safety decisions.",
  "With no --range: 24h, 7 days and 30 days side by side, details for 7 days.",
  "Day ranges start at local midnight.",
].join("\n");

const RANGE_LABEL: Record<Range, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};
const SOURCE_LABEL: Record<Source, string> = {
  hamness: "hamness",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export async function statsCommand({ args, dataDir, io }: CliContext): Promise<number> {
  let values: { range?: string; source?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        range: { type: "string" },
        source: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(`hamness stats: ${(e as Error).message}`);
    io.err(STATS_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(STATS_USAGE);
    return 0;
  }
  const range = values.range;
  if (range !== undefined && !(RANGES as readonly string[]).includes(range)) {
    io.err(`hamness stats: unknown range '${range}'`);
    io.err(STATS_USAGE);
    return 2;
  }
  const source = values.source;
  if (source !== undefined && !(SOURCES as readonly string[]).includes(source)) {
    io.err(`hamness stats: unknown source '${source}'`);
    io.err(STATS_USAGE);
    return 2;
  }

  const path = dataPaths(dataDir).database;
  if (!existsSync(path)) {
    io.out("No data yet. Run `hamness import` to bring in Claude Code and Codex history.");
    return 0;
  }
  const ranges: Range[] = range ? [range as Range] : ["24h", "7d", "30d"];
  const now = Date.now();
  const db = openDatabase(path);
  let reports: StatsReport[];
  try {
    reports = ranges.map((r) =>
      statsReport(db.sqlite, { range: r, source: source as Source | undefined, now }),
    );
  } finally {
    db.close();
  }

  if (values.json) io.out(JSON.stringify({ reports }, null, 2));
  else io.out(renderStats(reports, range ? 0 : 1));
  return 0;
}

// ---- Rendering ----

/** Micro-dollars as dollars: `$12.34`, `<$0.01`, `-` for none. */
export function money(micros: number | null): string {
  if (micros === null) return "-";
  if (micros > 0 && micros < 5_000) return "<$0.01";
  const dollars = micros / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 950, 12.3k, 4.5M, 1.2B. */
export function count(n: number): string {
  if (n < 1_000) return String(n);
  for (const [div, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const)
    if (n >= div) return `${(n / div).toFixed(1)}${unit}`;
  return String(n);
}

/** 45s, 12m, 3h 05m, 2d 4h. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const percent = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);

/** Pads cells into columns: the first column left-aligned, the rest right-aligned. */
function table(rows: string[][], indent = "  "): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  return rows.map(
    (row) =>
      indent +
      row
        .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
  );
}

const isEmpty = (r: StatsReport) =>
  r.kpis.sessions === 0 &&
  r.kpis.modelCalls === 0 &&
  r.kpis.tasks.total === 0 &&
  r.decisions.total === 0;

/**
 * The terminal summary: a KPI table with one column per report, then
 * sources, models, tools and decisions for `reports[detail]`.
 */
export function renderStats(reports: StatsReport[], detail: number): string {
  const d = reports[detail] ?? reports[0];
  if (!d) return "";
  const scope = d.source ? SOURCE_LABEL[d.source] : "all sources";
  const lines = [`hamness stats: ${scope}`, ""];

  if (reports.every(isEmpty)) {
    const span = reports.map((r) => RANGE_LABEL[r.range]).at(-1) ?? "";
    lines.push(`Nothing recorded in the last ${span}.`);
    if (!d.source || d.source !== "hamness")
      lines.push("Run `hamness import` to bring in Claude Code and Codex history.");
    return lines.join("\n");
  }

  const col = (f: (r: StatsReport) => string) => reports.map(f);
  // Imported history has no tasks, so task rows only mean something with hamness in scope.
  const hasTasks = d.source === null || d.source === "hamness";
  // The outcome breakdown only once there is a task to break down.
  const anyTasks = reports.some((r) => r.kpis.tasks.total > 0);
  lines.push(
    ...table([
      ["", ...col((r) => RANGE_LABEL[r.range])],
      ["Sessions", ...col((r) => count(r.kpis.sessions))],
      ...(hasTasks
        ? [
            ["Tasks", ...col((r) => count(r.kpis.tasks.total))],
            ...(anyTasks
              ? [
                  ["  verified", ...col((r) => count(r.kpis.tasks.verified))],
                  ["  unverified", ...col((r) => count(r.kpis.tasks.unverified))],
                  ["  overridden", ...col((r) => count(r.kpis.tasks.overridden))],
                  ["  abandoned", ...col((r) => count(r.kpis.tasks.abandoned))],
                  ["  open", ...col((r) => count(r.kpis.tasks.open))],
                ]
              : []),
            ["Verified rate", ...col((r) => percent(r.kpis.verifiedRate))],
          ]
        : []),
      ["Cost", ...col((r) => money(r.kpis.costMicros))],
      ...(hasTasks
        ? [["Per verified task", ...col((r) => money(r.kpis.costPerVerifiedTaskMicros))]]
        : []),
      ["Model calls", ...col((r) => count(r.kpis.modelCalls))],
      ["Tokens", ...col((r) => count(r.kpis.tokens.prompt + r.kpis.tokens.output))],
      ["  cache read", ...col((r) => count(r.kpis.tokens.cacheRead))],
      ["Wall time", ...col((r) => duration(r.kpis.wallMs))],
      [
        "Active time",
        ...col((r) => (r.kpis.activeSessions === 0 ? "-" : duration(r.kpis.activeMs))),
      ],
    ]),
  );

  const span = RANGE_LABEL[d.range];
  lines.push("", `By source, ${span}`);
  lines.push(
    ...table([
      ["Source", "Sessions", "Calls", "Cost", "Tokens", "Tasks", "Verified"],
      ...d.sources.map((s) => [
        SOURCE_LABEL[s.source],
        count(s.sessions),
        count(s.modelCalls),
        money(s.costMicros),
        count(s.tokens),
        count(s.tasks),
        count(s.verified),
      ]),
    ]),
  );

  lines.push("", `Top models, ${span}`);
  if (d.models.length === 0) lines.push("  None recorded.");
  else
    lines.push(
      ...table([
        ["Model", "Calls", "Cost", "Tokens"],
        ...d.models.map((m) => [
          m.priced ? m.model : `${m.model} *`,
          count(m.calls),
          money(m.costMicros),
          count(m.tokens.prompt + m.tokens.output),
        ]),
      ]),
    );

  lines.push("", `Top tools, ${span}`);
  if (d.tools.length === 0) lines.push("  None recorded.");
  else
    lines.push(
      ...table([
        ["Tool", "Calls", "Errors", "Avg time"],
        ...d.tools.map((t) => [
          t.tool,
          count(t.calls),
          count(t.errors),
          t.avgDurationMs === null ? "-" : duration(t.avgDurationMs),
        ]),
      ]),
    );

  lines.push("", `Safety decisions, ${span}`);
  if (d.decisions.total === 0) lines.push("  None recorded.");
  else {
    lines.push(
      ...table([
        ["Decided by", "Total", "Allow", "Ask", "Deny"],
        ...d.decisions.bySource.map((s) => [
          s.source,
          count(s.total),
          count(s.allow),
          count(s.ask),
          count(s.deny),
        ]),
      ]),
    );
    const j = d.decisions.judge;
    if (j.decisions > 0)
      lines.push(
        `  Judge: ${j.avgLatencyMs === null ? "-" : `${j.avgLatencyMs} ms`} average, ${money(j.costMicros)} total`,
      );
  }

  const notes: string[] = [];
  if (reports.some((r) => r.kpis.pricing.estimated))
    notes.push("Cost of imported history is estimated from token counts.");
  const widest = reports.at(-1);
  const pricing = widest?.kpis.pricing;
  if (widest && pricing && pricing.unpricedCalls > 0) {
    const n = pricing.unpricedCalls;
    const marked = d.models.some((m) => !m.priced) ? " (marked *)" : "";
    notes.push(
      `${count(n)} model ${n === 1 ? "call" : "calls"} in ${RANGE_LABEL[widest.range]} ` +
        `with no known price, counted as $0: ` +
        `${pricing.unpricedModels.join(", ")}${marked}.`,
    );
  }
  if (d.source === null)
    notes.push("Tasks, verified rate and cost per verified task cover hamness sessions only.");
  if (notes.length > 0) lines.push("", "Notes", ...notes.map((n) => `  ${n}`));
  return lines.join("\n");
}
