import { join } from "node:path";
import { projectKey, projectRoot } from "../compat/paths.ts";
import { type Json, readJson, writeJsonAtomic } from "../config/json.ts";
import { userConfigFile } from "../config/paths.ts";
import type { SafetyMode } from "../events/types.ts";
import { addTrusted, allowItem, isTrusted } from "../trust/index.ts";
import { defaultRules } from "./defaults.ts";
import { parsePermission, type Rule } from "./rules.ts";

/**
 * Safety config lives under a `safety` key in two JSON files:
 * - user: `<dataDir>/config.json` (mode, approval timeout, rules)
 * - project: `<repo root>/.hamness/config.json` (rules only; "allow always" writes here)
 *
 * ```json
 * { "safety": { "mode": "auto", "approvalTimeoutSec": 900,
 *               "permission": { "bash": { "npm test *": "allow" }, "mcp__github__*": "ask" } } }
 * ```
 * Files are read on every check, so edits apply to the next tool call.
 *
 * The judge's settings are user-only (a repo cannot raise the budget):
 * `{ "safety": { "judge": { "model": "claude-haiku-5-5", "dailyBudgetUsd": 1, "timeoutSec": 8 } } }`
 */

export type { SafetyMode };
export const SAFETY_MODES: readonly SafetyMode[] = ["ask", "auto", "yolo"];

export interface SafetyConfig {
  mode: SafetyMode;
  approvalTimeoutMs: number;
  /** Defaults, then user rules, then project rules (allow rules only once trusted). */
  rules: Rule[];
  /** Project allow rules left out because the repo has not trusted them (`hamness trust`). */
  untrusted: Rule[];
}

export const DEFAULT_MODE: SafetyMode = "auto";
export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;

export const userConfigPath = userConfigFile;

/**
 * The project root (`projectRoot`: the repo root, the main repo's for a worktree) holds
 * `.hamness/`; outside a repo, the cwd does.
 */
export function projectConfigPath(cwd: string): string {
  return join(projectRoot(cwd), ".hamness", "config.json");
}

function safetyBlock(path: string, file: Json | undefined): Json {
  const block = file?.safety;
  if (block === undefined) return {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${path}: "safety" must be an object`);
  }
  return block as Json;
}

export function loadSafetyConfig(dataDir: string, cwd: string): SafetyConfig {
  const userPath = userConfigPath(dataDir);
  const projectPath = projectConfigPath(cwd);
  const user = safetyBlock(userPath, readJson(userPath));
  const project = safetyBlock(projectPath, readJson(projectPath));

  const mode = user.mode ?? DEFAULT_MODE;
  if (typeof mode !== "string" || !(SAFETY_MODES as readonly string[]).includes(mode)) {
    throw new Error(`${userPath}: safety.mode must be one of ${SAFETY_MODES.join(", ")}`);
  }
  const timeoutSec = user.approvalTimeoutSec;
  if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !(timeoutSec > 0))) {
    throw new Error(`${userPath}: safety.approvalTimeoutSec must be a positive number`);
  }

  const parse = (path: string, block: Json, layer: "user" | "project") => {
    try {
      return parsePermission(block.permission, layer);
    } catch (err) {
      throw new Error(`${path}: safety.${(err as Error).message}`);
    }
  };

  // A repo's allow rules loosen safety, so they wait for the user's trust (ADR 0020).
  const key = projectKey(cwd);
  const projectRules = parse(projectPath, project, "project");
  const isTrustedRule = (r: Rule) =>
    r.verdict !== "allow" || isTrusted(dataDir, key, "safety", allowItem(r.tool, r.pattern));

  return {
    mode: mode as SafetyMode,
    approvalTimeoutMs: timeoutSec === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : timeoutSec * 1000,
    rules: [
      ...defaultRules(),
      ...parse(userPath, user, "user"),
      ...projectRules.filter(isTrustedRule),
    ],
    untrusted: projectRules.filter((r) => !isTrustedRule(r)),
  };
}

/**
 * Appends rules to the project config ("allow always"). A pattern already there moves to the
 * end. The user chose them, so their allow rules are trusted for the repo as they are saved.
 */
export function addProjectRules(dataDir: string, cwd: string, rules: Rule[]): string {
  const path = projectConfigPath(cwd);
  const file = readJson(path) ?? {};
  const safety = { ...safetyBlock(path, file) };
  const permission: Record<string, unknown> = {
    ...((safety.permission as Json | undefined) ?? {}),
  };

  for (const rule of rules) {
    const current = permission[rule.tool];
    const patterns: Record<string, unknown> =
      typeof current === "string" ? { "*": current } : { ...((current as Json | undefined) ?? {}) };
    delete patterns[rule.pattern];
    patterns[rule.pattern] = rule.verdict;
    permission[rule.tool] = patterns;
  }
  safety.permission = permission;
  file.safety = safety;

  writeJsonAtomic(path, file, 0o644);
  const allows = rules.filter((r) => r.verdict === "allow");
  addTrusted(
    dataDir,
    projectKey(cwd),
    "safety",
    allows.map((r) => allowItem(r.tool, r.pattern)),
  );
  return path;
}

export interface JudgeConfig {
  model: string;
  /** Spend cap per local day, in micro-dollars. */
  dailyBudgetMicros: number;
  timeoutMs: number;
}

/** Claude Haiku 5.5: cheap and fast. */
export const DEFAULT_JUDGE_MODEL = "claude-haiku-5-5";
export const DEFAULT_JUDGE_BUDGET_USD = 1;
export const DEFAULT_JUDGE_TIMEOUT_MS = 8000;

/** The judge's settings from the user config. */
export function loadJudgeConfig(dataDir: string): JudgeConfig {
  const path = userConfigPath(dataDir);
  const raw = safetyBlock(path, readJson(path)).judge ?? {};
  const bad = (what: string) => new Error(`${path}: safety.judge${what}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad(" must be an object");
  const j = raw as Json;
  const model = j.model ?? DEFAULT_JUDGE_MODEL;
  if (typeof model !== "string" || !model.trim()) throw bad(".model must be a model id");
  const budget = j.dailyBudgetUsd ?? DEFAULT_JUDGE_BUDGET_USD;
  if (typeof budget !== "number" || !(budget >= 0)) {
    throw bad(".dailyBudgetUsd must be a number of dollars, 0 or more");
  }
  const timeout = j.timeoutSec;
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    throw bad(".timeoutSec must be a positive number");
  }
  return {
    model: model.trim(),
    dailyBudgetMicros: Math.round(budget * 1_000_000),
    timeoutMs: timeout === undefined ? DEFAULT_JUDGE_TIMEOUT_MS : timeout * 1000,
  };
}
