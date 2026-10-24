import { dashboardPage } from "../dashboard/index.ts";
import type { HamnessDb } from "../db/open.ts";
import {
  CursorError,
  type DecisionSource,
  listDecisions,
  listTasks,
  RANGES,
  type Range,
  SOURCES,
  type Source,
  statsReport,
  taskEvidence,
  type Verdict,
} from "../stats/index.ts";
import type { TaskOutcome } from "../tasks/types.ts";
import type { DashboardMount } from "./server.ts";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

class BadParam extends Error {}

const OUTCOMES: readonly TaskOutcome[] = [
  "open",
  "verified",
  "unverified",
  "overridden",
  "abandoned",
];
const VERDICTS: readonly Verdict[] = ["allow", "ask", "deny"];
const DECIDERS: readonly DecisionSource[] = ["rule", "judge", "hook", "user", "mode"];

function oneOf<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!(allowed as readonly string[]).includes(v))
    throw new BadParam(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function int(url: URL, name: string, min: number, max: number): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!/^-?\d+$/.test(v) || Number(v) < min || Number(v) > max)
    throw new BadParam(`${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

/** `range` (default 7d), `source` (one source, or `all`) and `tz` (minutes east of UTC). */
function window(url: URL): { range: Range; source: Source | undefined; utcOffsetMinutes?: number } {
  const range = oneOf(url, "range", RANGES) ?? "7d";
  const source =
    url.searchParams.get("source") === "all" ? undefined : oneOf(url, "source", SOURCES);
  const tz = int(url, "tz", -14 * 60, 14 * 60);
  return { range, source, ...(tz !== undefined ? { utcOffsetMinutes: tz } : {}) };
}

function page(url: URL): { limit?: number; cursor?: string } {
  const limit = int(url, "limit", 1, 500);
  const cursor = url.searchParams.get("cursor") || undefined;
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) };
}

function bool(url: URL, name: string): boolean | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (v !== "true" && v !== "false") throw new BadParam(`${name} must be true or false`);
  return v === "true";
}

/**
 * The dashboard's data routes, behind the token check (all GET, read-only):
 * - `/v1/stats?range&source&tz`: the stats report (`hamness stats --json` for one range)
 * - `/v1/tasks?range&source&tz&outcome&turns&limit&cursor`: tasks, newest first
 * - `/v1/tasks/:id/evidence`: a task's evidence with each checker's one-line summary
 * - `/v1/decisions?range&source&tz&verdict&decidedBy&limit&cursor`: safety decisions
 */
export function dashboardRoutes(db: HamnessDb) {
  return async (req: Request, url: URL): Promise<Response | undefined> => {
    if (req.method !== "GET") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return undefined;
    try {
      if (parts.length === 2 && parts[1] === "stats")
        return json(statsReport(db.sqlite, window(url)));
      if (parts.length === 2 && parts[1] === "tasks")
        return json(
          listTasks(db.sqlite, {
            ...window(url),
            ...page(url),
            outcome: oneOf(url, "outcome", OUTCOMES),
            turns: bool(url, "turns"),
          }),
        );
      if (parts.length === 4 && parts[1] === "tasks" && parts[3] === "evidence") {
        const id = parts[2] ?? "";
        const exists = db.sqlite.query("SELECT 1 FROM tasks WHERE id = ?").get(id);
        if (!exists) return json({ error: "no such task" }, 404);
        return json({ evidence: taskEvidence(db.sqlite, id) });
      }
      if (parts.length === 2 && parts[1] === "decisions")
        return json(
          listDecisions(db.sqlite, {
            ...window(url),
            ...page(url),
            verdict: oneOf(url, "verdict", VERDICTS),
            decidedBy: oneOf(url, "decidedBy", DECIDERS),
          }),
        );
    } catch (err) {
      if (err instanceof BadParam || err instanceof CursorError)
        return json({ error: err.message }, 400);
      throw err;
    }
    return undefined;
  };
}

/** The dashboard page plus its data routes, for `startApiServer({ dashboard })`. */
export function dashboardMount(db: HamnessDb): DashboardMount {
  return { page: dashboardPage, api: dashboardRoutes(db) };
}
