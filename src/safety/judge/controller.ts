import type { HamnessDb } from "../../db/open.ts";
import type { JudgeState } from "../../events/types.ts";
import { loadJudgeConfig } from "../config.ts";
import type { Judge, JudgeRequest, JudgeVerdict } from "../service.ts";
import type { BackendJudge } from "./anthropic.ts";

/** This many judge asks in a row in a session pause its judge (ADR 0006). */
export const BACK_OFF = 3;

export const BUDGET_REACHED = "judge budget reached";

export interface JudgeControllerOptions {
  db: HamnessDb;
  dataDir: string;
  /** The model call. None: no API key, so the judge is off. */
  backend?: BackendJudge;
  now?: () => number;
  /** Called when a session's judge state changes (once per change, not per call). */
  onState?: (sessionId: string, state: JudgeState, reason: string) => void;
}

export interface JudgeController {
  /** The safety service's judge: never throws, always answers. */
  judge: Judge;
  state(sessionId: string): JudgeState;
  /** Unpauses a session's judge (`/judge resume`). False when it was not paused. */
  resume(sessionId: string): boolean;
}

/** Local midnight at or before `now`. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const STATE_REASON: Record<JudgeState, string> = {
  on: "the judge is on",
  paused: `the judge asked ${BACK_OFF} times in a row, so it is paused for this session (/judge resume)`,
  "over-budget": `${BUDGET_REACHED} for today (safety.judge.dailyBudgetUsd)`,
  "no-key": "no Anthropic API key, so the judge is off and undecided calls ask",
};

/**
 * Wraps the judge model with what ADR 0006 asks of it: a deadline, a daily budget computed from
 * stored judge decisions, and a per-session back-off. Anything that goes wrong is an ask.
 */
export function createJudgeController(opts: JudgeControllerOptions): JudgeController {
  const now = opts.now ?? Date.now;
  const asksInARow = new Map<string, number>();
  const paused = new Set<string>();
  const shown = new Map<string, JudgeState>();

  const spentToday = () =>
    opts.db.sqlite
      .query<{ spent: number | null }, [number]>(
        "SELECT sum(cost_micros) AS spent FROM decisions WHERE source = 'judge' AND created_at >= ?",
      )
      .get(startOfDay(now()))?.spent ?? 0;

  function state(sessionId: string): JudgeState {
    if (!opts.backend) return "no-key";
    if (paused.has(sessionId)) return "paused";
    let budget: number;
    try {
      budget = loadJudgeConfig(opts.dataDir).dailyBudgetMicros;
    } catch {
      return "on"; // the judge call reports the config error
    }
    return spentToday() >= budget ? "over-budget" : "on";
  }

  function show(sessionId: string, s: JudgeState) {
    if ((shown.get(sessionId) ?? "on") === s) return;
    shown.set(sessionId, s);
    opts.onState?.(sessionId, s, STATE_REASON[s]);
  }

  async function call(backend: BackendJudge, req: JudgeRequest): Promise<JudgeVerdict> {
    let timeoutMs = 0;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = loadJudgeConfig(opts.dataDir);
      timeoutMs = config.timeoutMs;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });
      return await Promise.race([
        backend(req, { signal: ac.signal, model: config.model }),
        timedOut,
      ]);
    } catch (err) {
      const reason = ac.signal.aborted
        ? `the judge did not answer within ${timeoutMs / 1000}s`
        : `the judge failed: ${(err as Error).message}`;
      return { verdict: "ask", reason };
    } finally {
      clearTimeout(timer);
    }
  }

  const judge: Judge = async (req) => {
    const s = state(req.sessionId);
    show(req.sessionId, s);
    const backend = opts.backend;
    if (s !== "on" || !backend) {
      const reason = s === "over-budget" ? BUDGET_REACHED : STATE_REASON[s];
      return { verdict: "ask", reason, skipped: true };
    }

    const v = await call(backend, req);
    if (v.verdict === "allow") {
      asksInARow.delete(req.sessionId);
      return v;
    }
    const n = (asksInARow.get(req.sessionId) ?? 0) + 1;
    asksInARow.set(req.sessionId, n);
    if (n >= BACK_OFF) {
      paused.add(req.sessionId);
      show(req.sessionId, "paused");
    }
    return v;
  };

  return {
    judge,
    state,
    resume(sessionId) {
      asksInARow.delete(sessionId);
      if (!paused.delete(sessionId)) return false;
      show(sessionId, state(sessionId));
      return true;
    },
  };
}
