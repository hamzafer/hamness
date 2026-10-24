import type { HamnessDb } from "../../db/open.ts";
import type { JudgeState } from "../../events/types.ts";
import { costMicros, priceFor } from "../../models/prices.ts";
import { loadJudgeConfig } from "../config.ts";
import type { Judge, JudgeRequest, JudgeVerdict } from "../service.ts";
import { type BackendJudge, judgeInputTokens } from "./anthropic.ts";

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
  /**
   * Estimated cost of calls in flight (S-L2): counted against the budget until their decision
   * row is stored, so calls running at once can't each spend the last of it.
   */
  let reserved = 0;
  /** Why the state is what it is, when that is more than the fixed reason (an unpriced model). */
  let unpricedReason: string | undefined;
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
    let model: string;
    try {
      const config = loadJudgeConfig(opts.dataDir);
      budget = config.dailyBudgetMicros;
      model = config.model;
    } catch {
      return "on"; // the judge call reports the config error
    }
    // With no price hamness can't know what the judge spends, so it can't keep the budget.
    if (!priceFor(model)) {
      unpricedReason = `the judge model ${model} has no price, so hamness can't keep its daily budget; set safety.judge.model to a priced model`;
      return "over-budget";
    }
    unpricedReason = undefined;
    return spentToday() + reserved >= budget ? "over-budget" : "on";
  }

  function estimate(req: JudgeRequest): number {
    let model: string;
    try {
      model = loadJudgeConfig(opts.dataDir).model;
    } catch {
      return 0;
    }
    return (
      costMicros(model, { input: judgeInputTokens(req), output: 0, cacheRead: 0, cacheWrite: 0 }) ??
      0
    );
  }

  function show(sessionId: string, s: JudgeState) {
    if ((shown.get(sessionId) ?? "on") === s) return;
    shown.set(sessionId, s);
    opts.onState?.(
      sessionId,
      s,
      s === "over-budget" && unpricedReason ? unpricedReason : STATE_REASON[s],
    );
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
      if (ac.signal.aborted) {
        // The request was sent and likely billed: count its estimated input cost (S-L2).
        const cost = estimate(req);
        return {
          verdict: "ask",
          reason: `the judge did not answer within ${timeoutMs / 1000}s`,
          ...(cost > 0 ? { costMicros: cost } : {}),
        };
      }
      return { verdict: "ask", reason: `the judge failed: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  const judge: Judge = async (req) => {
    const s = state(req.sessionId);
    show(req.sessionId, s);
    const backend = opts.backend;
    if (s !== "on" || !backend) {
      const reason = s === "over-budget" ? (unpricedReason ?? BUDGET_REACHED) : STATE_REASON[s];
      return { verdict: "ask", reason, skipped: true };
    }

    const hold = estimate(req);
    reserved += hold;
    let v: JudgeVerdict;
    try {
      v = await call(backend, req);
    } finally {
      // The safety service stores this call's decision row (with its cost) as soon as it
      // returns, so the reservation can go now.
      reserved -= hold;
    }
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
