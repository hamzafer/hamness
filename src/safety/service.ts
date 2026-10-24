import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HamnessDb } from "../db/open.ts";
import type { ApprovalDecision, SafetyMode } from "../events/types.ts";
import { addProjectRules, loadSafetyConfig } from "./config.ts";
import { type DecisionRecord, DecisionStore } from "./decisions.ts";
import type { GuardedCall, SafetyCheck, SafetyVerdict } from "./index.ts";
import {
  addUserProofCommands,
  evaluateProofCommand,
  loadProofConfig,
  PROVE_COMMAND,
} from "./proof.ts";
import { redactArgs, redactText } from "./redact.ts";
import { type Evaluation, evaluate, type Rule } from "./rules.ts";

/**
 * The safety check every tool call passes (ADR 0006), in order:
 *
 *   hooks ── deny ─────────────────────────────────────────▶ deny (source: hook, final)
 *         └─ allow / ask: recorded, then the rules still run (a rule deny wins)
 *   yolo mode ─────────────────────────────────────────────▶ allow (source: mode)
 *   rules ── allow / deny ─────────────────────────────────▶ verdict (source: rule)
 *         └─ ask ─────────────────────────────────────────▶ user
 *         └─ undecided ── auto mode + judge ── allow ─────▶ allow (source: judge)
 *                     │                    ├─ ask / error ▶ user
 *                     │                    └─ skipped ────▶ user (source: mode; paused, budget, no key)
 *                     └─ ask mode (or no judge) ─────────▶ user
 *   user ── allow once / allow always (saved) / deny / timeout
 *
 * Every step is a row in the decisions table.
 */

/** What the judge is given: the call (args redacted) and what the rules said. */
export interface JudgeRequest {
  sessionId: string;
  cwd: string;
  tool: string;
  args: Record<string, unknown>;
  evaluation: Evaluation;
}

export interface JudgeVerdict {
  verdict: "allow" | "ask";
  reason: string;
  category?: string;
  costMicros?: number;
  /** The judge did not run (paused, over budget, no key): recorded with source `mode`. */
  skipped?: boolean;
}

/** Decides undecided calls in `auto` mode. Throwing means ask. Budget and back-off live in it. */
export type Judge = (req: JudgeRequest) => Promise<JudgeVerdict>;

/** What a Claude Code PreToolUse hook decided (ticket #9). */
export interface HookVerdict {
  verdict: "allow" | "ask" | "deny";
  reason: string;
  /** The hook's command, stored as the decision's rule. */
  hook: string;
}

/** Runs the PreToolUse hooks for a call. Undefined: no hook decided. Throwing means no decision. */
export type PreToolHook = (call: GuardedCall, mode: SafetyMode) => Promise<HookVerdict | undefined>;

export interface SafetyServiceOptions {
  db: HamnessDb;
  dataDir: string;
  home?: string;
  /** The judge (`src/safety/judge/`). Without one `auto` asks the user for undecided calls, like `ask`. */
  judge?: Judge;
  /** Claude Code PreToolUse hooks; they run before the rules. */
  preToolHook?: PreToolHook;
}

export interface SafetyService {
  check: SafetyCheck;
  /** The mode for sessions in `cwd`, for clients' banners. */
  modeFor(cwd: string): SafetyMode | undefined;
}

/** The same call this many times in a row asks, whatever the rules say (opencode's doom_loop). */
export const DOOM_LOOP = 3;

/** Resolves symlinks in the longest existing part of a path (the rest may not exist yet). */
function realpathNearest(path: string): string {
  const tail: string[] = [];
  let cur = path;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return path;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

const ruleLabel = (r: Rule) => `${r.layer}: ${r.tool} ${r.pattern}`;

export function createSafetyService(opts: SafetyServiceOptions): SafetyService {
  const store = new DecisionStore(opts.db);
  const home = opts.home ?? homedir();
  const recent = new Map<string, { key: string; count: number }>();

  function repeats(call: GuardedCall): number {
    const key = `${call.tool}\0${JSON.stringify(call.args)}`;
    const last = recent.get(call.sessionId);
    const count = last?.key === key ? last.count + 1 : 1;
    recent.set(call.sessionId, { key, count });
    return count;
  }

  const check: SafetyCheck = async (call, ctx) => {
    const t0 = performance.now();
    const args = redactArgs(call.args);
    const cwd = call.cwd ?? ctx?.cwd;
    const base = { sessionId: call.sessionId, toolCallId: call.toolCallId, tool: call.tool, args };
    if (!cwd) throw new Error("the call has no working directory");

    const config = loadSafetyConfig(opts.dataDir, cwd);
    const mode = config.mode;
    // A `prove` command re-run (ADR 0019): bash's deny and ask rules, the proof list for allow.
    const proving = call.tool === PROVE_COMMAND;
    const command = typeof call.args.command === "string" ? call.args.command : "";
    const record = (
      d: Omit<DecisionRecord, keyof typeof base | "mode" | "latencyMs">,
      since = t0,
    ) => store.add({ ...base, ...d, mode, latencyMs: performance.now() - since });

    // Claude Code hooks first: a deny is final; an allow or ask still meets the rules.
    let hook: HookVerdict | undefined;
    if (opts.preToolHook) {
      const th = performance.now();
      try {
        // Hooks know the re-run as the shell command it is.
        hook = await opts.preToolHook(proving ? { ...call, tool: "bash" } : call, mode);
      } catch {
        hook = undefined;
      }
      if (hook) {
        const reason = redactText(hook.reason);
        hook = { ...hook, reason };
        record({ verdict: hook.verdict, source: "hook", reason, rule: hook.hook }, th);
        if (hook.verdict === "deny") return { allow: false, reason };
      }
    }

    // yolo skips safety questions, not the proof gate's.
    if (mode === "yolo" && hook?.verdict !== "ask" && !proving) {
      if (hook?.verdict === "allow") return { allow: true };
      record({ verdict: "allow", source: "mode", reason: "yolo mode allows every call" });
      return { allow: true };
    }

    const evalCtx = { cwd, home, dataDir: opts.dataDir, realpath: realpathNearest };
    const evaluation = proving
      ? evaluateProofCommand(
          command,
          config.rules,
          loadProofConfig(opts.dataDir, cwd).commands,
          evalCtx,
        )
      : evaluate({ tool: call.tool, args: call.args }, config.rules, evalCtx);
    const ruleOf = evaluation.rule ? { rule: ruleLabel(evaluation.rule) } : {};
    // Reasons quote the command, so they are redacted like the args.
    const because = redactText(evaluation.reason);
    const looping = repeats(call) >= DOOM_LOOP;

    if (evaluation.verdict === "deny") {
      record({ verdict: "deny", source: "rule", reason: because, ...ruleOf });
      return { allow: false, reason: because };
    }
    if (hook?.verdict === "allow" && evaluation.verdict !== "ask" && !looping && !proving) {
      return { allow: true };
    }
    if (evaluation.verdict === "allow" && !looping && hook?.verdict !== "ask") {
      record({ verdict: "allow", source: "rule", reason: because, ...ruleOf });
      return { allow: true };
    }

    let reason = because;
    let suggestions = evaluation.suggestions;
    if (looping && evaluation.verdict !== "ask") {
      reason = `the same call ran ${DOOM_LOOP} times in a row`;
      suggestions = [];
      record({ verdict: "ask", source: "rule", reason, rule: "doom_loop" });
    } else if (evaluation.verdict === "ask") {
      record({ verdict: "ask", source: "rule", reason, ...ruleOf });
    } else if (hook?.verdict === "ask") {
      // The hook's ask is already recorded; like an explicit ask rule, it offers no "always".
      reason = hook.reason;
      suggestions = [];
    } else if (proving) {
      // Whether a command counts as proof is the user's call, never the judge's.
      record({ verdict: "ask", source: "rule", reason, rule: "proof command list" });
    } else {
      // Undecided: the judge's turn in auto mode.
      if (mode === "auto" && opts.judge) {
        const tj = performance.now();
        let judged: JudgeVerdict;
        try {
          judged = await opts.judge({
            sessionId: call.sessionId,
            cwd,
            tool: call.tool,
            args,
            evaluation: { ...evaluation, reason: because },
          });
        } catch (err) {
          judged = { verdict: "ask", reason: `the judge failed: ${(err as Error).message}` };
        }
        record(
          {
            verdict: judged.verdict,
            source: judged.skipped ? "mode" : "judge",
            reason: judged.reason,
            ...(judged.category ? { category: judged.category } : {}),
            ...(judged.costMicros ? { costMicros: judged.costMicros } : {}),
          },
          tj,
        );
        if (judged.verdict === "allow") return { allow: true };
        reason = judged.reason;
      } else {
        const why = mode === "auto" ? "no judge, so it asks" : "ask mode";
        record({ verdict: "ask", source: "mode", reason: `${reason}; ${why}` });
      }
    }

    if (!ctx) {
      const r = "no client can be asked";
      record({ verdict: "deny", source: "mode", reason: r });
      return { allow: false, reason: r };
    }

    const tu = performance.now();
    const answer = await ctx.askUser({
      toolCallId: call.toolCallId,
      tool: call.tool,
      args,
      reason,
      suggestions: suggestions.map((s) => ({ tool: s.tool, pattern: s.pattern })),
      timeoutMs: config.approvalTimeoutMs,
    });
    return settle(
      answer,
      suggestions,
      cwd,
      (d) => record(d, tu),
      call.sessionId,
      config.approvalTimeoutMs,
    );
  };

  function settle(
    answer: ApprovalAnswer,
    suggestions: Rule[],
    cwd: string,
    record: (
      d: Omit<DecisionRecord, "sessionId" | "toolCallId" | "tool" | "args" | "mode" | "latencyMs">,
    ) => void,
    sessionId: string,
    timeoutMs: number,
  ): SafetyVerdict {
    if (answer.by === "timeout") {
      const reason = `no answer within ${Math.round(timeoutMs / 1000)}s`;
      record({ verdict: "deny", source: "mode", reason });
      return { allow: false, reason };
    }
    if (answer.by === "abort") {
      const reason = "the run was stopped";
      record({ verdict: "deny", source: "user", reason });
      return { allow: false, reason };
    }
    if (answer.decision === "deny") {
      const reason = answer.reason ?? "denied by the user";
      record({ verdict: "deny", source: "user", reason });
      return { allow: false, reason };
    }
    recent.delete(sessionId);
    const proofSaves = suggestions.filter((s) => s.tool === PROVE_COMMAND);
    if (answer.decision === "allow-always" && proofSaves.length > 0) {
      addUserProofCommands(
        opts.dataDir,
        proofSaves.map((s) => s.pattern),
      );
      const saved = proofSaves.map((s) => `"${s.pattern}"`).join(", ");
      record({
        verdict: "allow",
        source: "user",
        reason: `allowed always: saved ${saved} to the user's proof command list`,
      });
      return { allow: true };
    }
    if (answer.decision === "allow-always" && suggestions.length > 0) {
      addProjectRules(opts.dataDir, cwd, suggestions);
      const saved = suggestions.map((s) => `${s.tool} "${s.pattern}"`).join(", ");
      record({
        verdict: "allow",
        source: "user",
        reason: `allowed always: saved ${saved} to the project config`,
      });
      return { allow: true };
    }
    record({ verdict: "allow", source: "user", reason: "allowed once" });
    return { allow: true };
  }

  return {
    check,
    modeFor(cwd) {
      try {
        return loadSafetyConfig(opts.dataDir, cwd).mode;
      } catch {
        return undefined;
      }
    },
  };
}

export interface ApprovalAnswer {
  decision: ApprovalDecision;
  by: "user" | "timeout" | "abort";
  reason?: string;
}
