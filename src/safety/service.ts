import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { HamnessDb } from "../db/open.ts";
import type { ApprovalDecision, SafetyMode } from "../events/types.ts";
import { stableJson } from "../trust/index.ts";
import { addProjectRules, loadSafetyConfig } from "./config.ts";
import { type DecisionRecord, DecisionStore } from "./decisions.ts";
import type { GuardedCall, SafetyCheck, SafetyVerdict } from "./index.ts";
import { addUserProofCommands, loadProofConfig, PROVE_COMMAND, proofListing } from "./proof.ts";
import { redactArgs, redactText } from "./redact.ts";
import { type Evaluation, evaluate, type ListOptions, type Rule } from "./rules.ts";

/**
 * The safety check every tool call passes (ADR 0006), in order:
 *
 *   hooks ── deny ─────────────────────────────────────────▶ deny (source: hook, final)
 *         └─ allow / ask: recorded, then the rules still run (a rule deny wins)
 *   rules ── deny ─────────────────────────────────────────▶ deny (source: rule; yolo too)
 *   yolo mode ── anything else (not a hook ask) ───────────▶ allow (source: mode; ADR 0022)
 *   rules ── allow ────────────────────────────────────────▶ allow (source: rule)
 *         └─ ask ─────────────────────────────────────────▶ user
 *         └─ undecided ── auto mode + judge ── allow ─────▶ allow (source: judge)
 *                     │                    ├─ ask / error ▶ user
 *                     │                    └─ skipped ────▶ user (source: mode; paused, budget, no key)
 *                     └─ ask mode (or no judge) ─────────▶ user
 *   user ── allow once / allow always (saved) / deny / timeout
 *
 * A `prove` command re-run (`prove_command`, ADR 0019) takes the same path as the bash
 * command it is (yolo runs it, bash denies still apply), then must be on the proof command
 * list to count: if not, the user is asked "count it as proof?" in every mode (one question
 * when the run needs the user too).
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
  /** The mode for a session in `cwd` (its own, else the config's), for clients' banners. */
  modeFor(cwd: string, sessionId?: string): SafetyMode | undefined;
  /** The user's mode for one session (`/mode`); undefined goes back to the config's. */
  setSessionMode(sessionId: string, mode: SafetyMode | undefined): void;
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

const caseCache = new Map<string, boolean>();

/**
 * Whether the filesystem under `dir` ignores case (V-M4; macOS and Windows by default), found
 * once per folder: the folder (or the nearest one above it with a letter in its name) is also
 * there, as the same inode, under its name in another case.
 */
export function caseInsensitiveAt(dir: string): boolean {
  const start = realpathNearest(dir);
  const hit = caseCache.get(start);
  if (hit !== undefined) return hit;
  let found = false;
  for (let cur = start; ; cur = dirname(cur)) {
    const name = basename(cur);
    const flipped = [...name]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    if (flipped !== name) {
      try {
        const a = statSync(cur);
        const b = statSync(join(dirname(cur), flipped));
        found = a.ino === b.ino && a.dev === b.dev;
      } catch {
        found = false;
      }
      break;
    }
    if (dirname(cur) === cur) {
      // No letters anywhere in the path: the platform's default.
      found = process.platform === "darwin" || process.platform === "win32";
      break;
    }
  }
  caseCache.set(start, found);
  return found;
}

/** More matches than this and a glob is not checked (the command is not allowed outright). */
const GLOB_LIMIT = 500;

/**
 * Expands an absolute shell glob to the paths it matches now, as bash would without
 * `globstar` (`**` is `*`), dot files included. Undefined past `GLOB_LIMIT` matches.
 */
export function expandGlob(pattern: string): string[] | undefined {
  const parts = pattern.replaceAll("**", "*").split("/");
  let fixed = 0;
  while (fixed < parts.length - 1 && !/[*?[{]/.test(parts[fixed] as string)) fixed++;
  const root = parts.slice(0, fixed).join("/") || "/";
  const rest = parts.slice(fixed).join("/");
  const out: string[] = [];
  try {
    const glob = new Bun.Glob(rest);
    for (const match of glob.scanSync({ cwd: root, dot: true, onlyFiles: false, absolute: true })) {
      out.push(match);
      if (out.length > GLOB_LIMIT) return undefined;
    }
  } catch {
    // The folder is missing or unreadable: nothing matches.
  }
  return out;
}

/** More files than this under a recursive read's root and it is not checked (not allowed outright). */
const LIST_LIMIT = 200_000;

/**
 * The files a recursive read under `root` would open (V-M5). With ripgrep installed it lists
 * them exactly as rg would (`ignore`: honour .gitignore and the like; `hidden`: dot files);
 * without it, every file is listed, ignore files or not (stricter). `.git` is skipped, as rg
 * does. Undefined past `LIST_LIMIT` files or when listing fails.
 */
export function listFiles(root: string, opts: ListOptions): string[] | undefined {
  try {
    if (statSync(root).isFile()) return [root];
  } catch {
    return [];
  }
  const rg = Bun.which("rg");
  if (rg) {
    const args = ["--files", "--no-config", "--no-messages"];
    if (opts.hidden) args.push("--hidden");
    if (!opts.ignore) args.push("--no-ignore");
    const run = Bun.spawnSync([rg, ...args, "--", root], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    // 0: files listed, 1: none, 2: some could not be read (the rest are still listed).
    if (run.exitCode === 0 || run.exitCode === 1 || run.exitCode === 2) {
      const out = run.stdout.toString("utf8").split("\n").filter(Boolean);
      return out.length > LIST_LIMIT ? undefined : out.map((f) => resolve(root, f));
    }
    return undefined;
  }
  const out: string[] = [];
  try {
    const glob = new Bun.Glob("**/*");
    for (const f of glob.scanSync({
      cwd: root,
      dot: opts.hidden,
      onlyFiles: true,
      absolute: true,
    })) {
      if (f.includes("/.git/")) continue;
      out.push(f);
      if (out.length > LIST_LIMIT) return undefined;
    }
  } catch {
    return undefined;
  }
  return out;
}

const ruleLabel = (r: Rule) => `${r.layer}: ${r.tool} ${r.pattern}`;

export function createSafetyService(opts: SafetyServiceOptions): SafetyService {
  const store = new DecisionStore(opts.db);
  const home = opts.home ?? homedir();
  const recent = new Map<string, { key: string; count: number }>();
  /** Modes the user set for one session (`/mode`); they win over the config's mode. */
  const sessionModes = new Map<string, SafetyMode>();

  function repeats(call: GuardedCall): number {
    // Same call however it is spelled: keys sorted, a command's spacing collapsed.
    const args =
      typeof call.args.command === "string"
        ? { ...call.args, command: call.args.command.replace(/\s+/g, " ").trim() }
        : call.args;
    const key = `${call.tool}\0${stableJson(args)}`;
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
    const mode = sessionModes.get(call.sessionId) ?? config.mode;
    // A `prove` command re-run (ADR 0019): the bash decision to run, the proof list to count.
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

    const evalCtx = {
      cwd,
      home,
      dataDir: opts.dataDir,
      realpath: realpathNearest,
      glob: expandGlob,
      caseInsensitive: caseInsensitiveAt(cwd),
      listFiles,
    };
    // A proof re-run may run exactly when the same bash command could (V-H1); the proof list
    // only decides whether it counts as evidence.
    const subject = proving ? { tool: "bash", args: { command } } : call;
    const evaluation = evaluate({ tool: subject.tool, args: subject.args }, config.rules, evalCtx);
    const listing = proving
      ? proofListing(command, config.rules, loadProofConfig(opts.dataDir, cwd).commands, evalCtx)
      : undefined;
    const ruleOf = evaluation.rule ? { rule: ruleLabel(evaluation.rule) } : {};
    // Reasons quote the command, so they are redacted like the args.
    const because = redactText(evaluation.reason);
    const looping = repeats(call) >= DOOM_LOOP;

    const ask = async (reason: string, suggestions: Rule[]): Promise<SafetyVerdict> => {
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
    /** Allowed to run: a proof re-run still has to be on the proof list to count. */
    const ran = (): Promise<SafetyVerdict> | SafetyVerdict => {
      if (!listing || listing.listed) return { allow: true };
      const reason = redactText(listing.reason);
      record({ verdict: "ask", source: "rule", reason, rule: "proof command list" });
      return ask(reason, listing.suggestions);
    };

    if (evaluation.verdict === "deny") {
      record({ verdict: "deny", source: "rule", reason: because, ...ruleOf });
      return { allow: false, reason: because };
    }
    // yolo skips asks, the judge and the doom loop, never a deny rule (ADR 0022), nor the
    // proof gate's "count it?" question. A hook's ask still asks, and so does a call the rules
    // could not see past (the floor: a recursive read over secrets, an unparsed command, a
    // path only known at run time), so yolo never silently reads a secret.
    const yolo = mode === "yolo" && hook?.verdict !== "ask";
    const yoloFloor = yolo && evaluation.floor !== undefined;
    if (yolo && !yoloFloor) {
      if (hook?.verdict === "allow") return ran();
      if (evaluation.verdict === "allow") {
        record({ verdict: "allow", source: "rule", reason: because, ...ruleOf });
      } else {
        const reason = proving
          ? "yolo mode runs it (no deny rule matched)"
          : "yolo mode allows it (no deny rule matched)";
        record({ verdict: "allow", source: "mode", reason });
      }
      return ran();
    }
    if (!yoloFloor && hook?.verdict === "allow" && evaluation.verdict !== "ask" && !looping) {
      return ran();
    }
    if (!yoloFloor && evaluation.verdict === "allow" && !looping && hook?.verdict !== "ask") {
      record({ verdict: "allow", source: "rule", reason: because, ...ruleOf });
      return ran();
    }

    let reason = because;
    let suggestions = evaluation.suggestions;
    if (yoloFloor) {
      reason = `yolo still asks: ${redactText(evaluation.floor ?? "")}`;
      suggestions = [];
      record({ verdict: "ask", source: "mode", reason });
    } else if (looping && evaluation.verdict !== "ask") {
      reason = `the same call ran ${DOOM_LOOP} times in a row`;
      suggestions = [];
      record({ verdict: "ask", source: "rule", reason, rule: "doom_loop" });
    } else if (evaluation.verdict === "ask") {
      record({ verdict: "ask", source: "rule", reason, ...ruleOf });
    } else if (hook?.verdict === "ask") {
      // The hook's ask is already recorded; like an explicit ask rule, it offers no "always".
      reason = hook.reason;
      suggestions = [];
    } else {
      // Undecided: the judge's turn in auto mode.
      if (mode === "auto" && opts.judge) {
        const tj = performance.now();
        let judged: JudgeVerdict;
        try {
          judged = await opts.judge({
            sessionId: call.sessionId,
            cwd,
            // The judge sees a proof re-run as the shell command it is.
            tool: subject.tool,
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
        if (judged.verdict === "allow") return ran();
        reason = judged.reason;
      } else {
        const why = mode === "auto" ? "no judge, so it asks" : "ask mode";
        record({ verdict: "ask", source: "mode", reason: `${reason}; ${why}` });
      }
    }

    // A proof re-run that needs the user to run it and is not listed: one question for both.
    if (listing && !listing.listed) {
      const both = `${redactText(listing.reason)}. Running it also needs your OK: ${reason}`;
      record({ verdict: "ask", source: "rule", reason: both, rule: "proof command list" });
      return ask(both, [...suggestions, ...listing.suggestions]);
    }
    return ask(reason, suggestions);
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
    if (answer.decision === "allow-always" && suggestions.length > 0) {
      // Proof patterns go to the user's proof list, never the project's (ADR 0019); run
      // permissions to the project config, as for any call.
      const proofSaves = suggestions.filter((s) => s.tool === PROVE_COMMAND);
      const ruleSaves = suggestions.filter((s) => s.tool !== PROVE_COMMAND);
      const saved: string[] = [];
      if (ruleSaves.length > 0) {
        addProjectRules(opts.dataDir, cwd, ruleSaves);
        const list = ruleSaves.map((s) => `${s.tool} "${s.pattern}"`).join(", ");
        saved.push(`${list} to the project config`);
      }
      if (proofSaves.length > 0) {
        addUserProofCommands(
          opts.dataDir,
          proofSaves.map((s) => s.pattern),
        );
        const list = proofSaves.map((s) => `"${s.pattern}"`).join(", ");
        saved.push(`${list} to the user's proof command list`);
      }
      record({
        verdict: "allow",
        source: "user",
        reason: `allowed always: saved ${saved.join(" and ")}`,
      });
      return { allow: true };
    }
    record({ verdict: "allow", source: "user", reason: "allowed once" });
    return { allow: true };
  }

  return {
    check,
    setSessionMode(sessionId, mode) {
      if (mode) sessionModes.set(sessionId, mode);
      else sessionModes.delete(sessionId);
    },
    modeFor(cwd, sessionId) {
      const own = sessionId === undefined ? undefined : sessionModes.get(sessionId);
      if (own) return own;
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
