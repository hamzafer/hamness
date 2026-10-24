import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { type Json, readJsonOr } from "../config/json.ts";
import { addTrusted, isTrusted } from "../trust/index.ts";
import { projectKey, projectRoot, repoRoot } from "./paths.ts";
import { toClaudeCall, toClaudeResponse } from "./tools.ts";

/**
 * Claude Code hooks (ADR 0008, ADR 0017): command hooks from Claude Code's settings files, run
 * with Claude Code's matcher and JSON stdin/stdout contract for PreToolUse, PostToolUse,
 * UserPromptSubmit, Stop and SessionStart.
 *
 * Sources, all merged: managed `managed-settings.json`, `<claude dir>/settings.json` (user), and
 * `.claude/settings.json` and `settings.local.json` at the repo root and in the cwd (project).
 * Project hooks run only as the user trusted them (`hamness trust`, ADR 0020): each hook's
 * definition is fingerprinted, so an added or edited hook waits for trust again. Files are read
 * for every event, so edits and trust apply at once. hamness never writes Claude Code's files.
 *
 * A hook that crashes, prints junk or times out decides nothing (logged), unless it set
 * `onFailure: "block"`. Only `type: "command"` handlers run; other types are skipped.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";

/** Claude Code's defaults, in seconds. */
const DEFAULT_TIMEOUT_SEC = 600;
const TIMEOUT_SEC: Partial<Record<HookEvent, number>> = { UserPromptSubmit: 30 };
/** Claude Code caps strings a hook adds to the context. */
const TEXT_MAX = 10_000;
const OUTPUT_MAX = 1_000_000;

export interface HookSession {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  /** Claude Code's permission mode name (`default`, `bypassPermissions`, ...). */
  permissionMode?: string;
}

export interface ToolCallInfo {
  /** Pi's tool name and args; hooks see Claude Code's (see `tools.ts`). */
  tool: string;
  args: Record<string, unknown>;
  toolUseId: string;
}

export interface PreToolOutcome {
  decision: "allow" | "ask" | "deny";
  reason: string;
  /** The hook that decided, for the audit log. */
  hook: string;
}

export interface ClaudeHooks {
  /** Undefined when no hook decided. */
  preToolUse(s: HookSession, call: ToolCallInfo): Promise<PreToolOutcome | undefined>;
  /** `context`: text to add next to the tool result for the model. */
  postToolUse(
    s: HookSession,
    call: ToolCallInfo & { output: string },
  ): Promise<{ context?: string }>;
  /** `blocked`: the prompt must not reach the model (the reason is for the user). */
  userPromptSubmit(s: HookSession, prompt: string): Promise<{ blocked?: string; context?: string }>;
  /** `continueWith`: the agent must keep going, with this as its instruction. */
  stop(
    s: HookSession,
    info: { stopHookActive: boolean; lastAssistantMessage: string },
  ): Promise<{ continueWith?: string }>;
  /** `notice`: something the user should know (project hooks held back until trusted). */
  sessionStart(
    s: HookSession,
    info: { source: "startup" | "resume"; model?: string },
  ): Promise<{ context?: string; notice?: string }>;
}

export interface ClaudeHooksOptions {
  /** Claude Code's config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
  claudeDir: string;
  /** hamness's data dir: its `config.json` keeps the trusted projects. */
  dataDir: string;
  /** Claude Code's managed policy folder (`managed-settings.json`); its hooks always run. */
  managedDir?: string;
  /** Logs hook failures. Default: stderr. */
  log?: (message: string) => void;
}

/** hamness's safety mode as Claude Code's `permission_mode`. */
export function claudePermissionMode(mode: string | undefined): string {
  return mode === "yolo" ? "bypassPermissions" : "default";
}

// ---- settings ----

interface Handler {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  timeout?: unknown;
  async?: unknown;
  onFailure?: unknown;
}

interface Group {
  matcher?: unknown;
  hooks?: unknown;
}

interface CommandHook {
  command: string;
  args?: string[];
  timeoutSec?: number;
  async: boolean;
  blockOnFailure: boolean;
  matcher?: string;
  label: string;
}

const readJson = (path: string, log: (m: string) => void): Json | undefined =>
  readJsonOr(path, (m) => log(`${m}; its hooks are skipped`));

export { projectRoot };

/**
 * Project settings files, Claude Code's way: `.claude/settings.json` and `settings.local.json`
 * at the repo root (for a worktree, its own top folder), and in the cwd when that differs.
 */
function projectSettingsFiles(cwd: string): string[] {
  const root = repoRoot(cwd) ?? resolve(cwd);
  const dirs = [root, resolve(cwd)];
  const files = dirs.flatMap((d) => [
    join(d, ".claude", "settings.json"),
    join(d, ".claude", "settings.local.json"),
  ]);
  return [...new Set(files)];
}

function commandHooks(file: Json | undefined, event: HookEvent): CommandHook[] {
  const groups = (file?.hooks as Json | undefined)?.[event];
  if (!Array.isArray(groups)) return [];
  const out: CommandHook[] = [];
  for (const g of groups as Group[]) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks as Handler[]) {
      if (!h || (h.type ?? "command") !== "command" || typeof h.command !== "string") continue;
      const args = Array.isArray(h.args) ? h.args.map(String) : undefined;
      out.push({
        command: h.command,
        ...(args ? { args } : {}),
        ...(typeof h.timeout === "number" && h.timeout > 0 ? { timeoutSec: h.timeout } : {}),
        async: h.async === true,
        blockOnFailure: h.onFailure === "block",
        ...(typeof g.matcher === "string" ? { matcher: g.matcher } : {}),
        label: args ? [h.command, ...args].join(" ") : h.command,
      });
    }
  }
  return out;
}

/** Claude Code's matcher: empty or `*` is all; names split on `|` or `,`; anything else a regex. */
export function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || value === undefined)
    return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .includes(value);
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

// ---- trust ----

/** What a hook's trust covers: everything that decides what it runs and how (ADR 0020). */
function hookItem(event: HookEvent, h: CommandHook) {
  return {
    event,
    matcher: h.matcher,
    command: h.command,
    args: h.args,
    timeoutSec: h.timeoutSec,
    async: h.async,
    blockOnFailure: h.blockOnFailure,
  };
}

export const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
];

/** Every project hook in `cwd`'s settings files, as trust items, with where it came from. */
export function projectHookItems(
  cwd: string,
): Array<{ file: string; label: string; item: unknown }> {
  return projectSettingsFiles(cwd).flatMap((file) => {
    const json = readJson(file, () => {});
    return HOOK_EVENTS.flatMap((event) =>
      commandHooks(json, event).map((h) => ({
        file,
        label: `${event}${h.matcher ? ` ${h.matcher}` : ""}: ${h.label}`,
        item: hookItem(event, h),
      })),
    );
  });
}

/** True when every project hook in `cwd` is trusted as it is now (so with none, too). */
export function isProjectTrusted(dataDir: string, cwd: string): boolean {
  const key = projectKey(cwd);
  return projectHookItems(cwd).every((h) => isTrusted(dataDir, key, "hooks", h.item));
}

/** Trusts the project hooks in `cwd` as they are now. Returns the project key it saved under. */
export function trustProject(dataDir: string, cwd: string): string {
  const key = projectKey(cwd);
  addTrusted(
    dataDir,
    key,
    "hooks",
    projectHookItems(cwd).map((h) => h.item),
  );
  return key;
}

export interface HookSource {
  file: string;
  scope: "managed" | "user" | "project";
  /** False when `disableAllHooks` is set, or for a project file with a hook not trusted yet. */
  runs: boolean;
  hooks: Array<{ event: HookEvent; matcher?: string; command: string; trusted: boolean }>;
}

type Scope = HookSource["scope"];
type HookOpts = { claudeDir: string; dataDir: string; managedDir?: string };

function settingsFiles(opts: HookOpts, cwd: string): Array<[string, Scope]> {
  return [
    ...(opts.managedDir
      ? [[join(opts.managedDir, "managed-settings.json"), "managed"] as [string, Scope]]
      : []),
    [join(opts.claudeDir, "settings.json"), "user"],
    ...projectSettingsFiles(cwd).map((f): [string, Scope] => [f, "project"]),
  ];
}

/** `disableAllHooks` in managed settings turns off every hook; elsewhere, all but managed. */
function disabledScopes(parsed: Array<{ scope: Scope; json: Json | undefined }>): Set<Scope> {
  const off = (scope: Scope) =>
    parsed.some((p) => p.scope === scope && p.json?.disableAllHooks === true);
  if (off("managed")) return new Set(["managed", "user", "project"]);
  if (off("user") || off("project")) return new Set(["user", "project"]);
  return new Set();
}

/** Every settings file with hooks for `cwd`, for `hamness hooks`. */
export function hookSources(opts: HookOpts, cwd: string): HookSource[] {
  const key = projectKey(cwd);
  const parsed = settingsFiles(opts, cwd).map(([file, scope]) => ({
    file,
    scope,
    json: readJson(file, () => {}),
  }));
  const disabled = disabledScopes(parsed);
  return parsed
    .map(({ file, scope, json }) => {
      const hooks = HOOK_EVENTS.flatMap((event) =>
        commandHooks(json, event).map((h) => ({
          event,
          ...(h.matcher ? { matcher: h.matcher } : {}),
          command: h.label,
          trusted: scope !== "project" || isTrusted(opts.dataDir, key, "hooks", hookItem(event, h)),
        })),
      );
      return { file, scope, runs: !disabled.has(scope) && hooks.every((h) => h.trusted), hooks };
    })
    .filter((src) => src.hooks.length > 0);
}

/** The hooks for an event in `cwd`, and whether project hooks were held back. */
export function loadHooks(
  opts: HookOpts & { log?: (m: string) => void },
  cwd: string,
  event: HookEvent,
): { hooks: CommandHook[]; heldBack: boolean } {
  const log = opts.log ?? (() => {});
  const key = projectKey(cwd);
  const parsed = settingsFiles(opts, cwd).map(([file, scope]) => ({
    scope,
    json: readJson(file, log),
  }));
  const disabled = disabledScopes(parsed);
  const hooks: CommandHook[] = [];
  let heldBack = false;
  for (const { scope, json } of parsed) {
    if (disabled.has(scope)) continue;
    if (scope !== "project") {
      hooks.push(...commandHooks(json, event));
      continue;
    }
    // Project hooks run only as trusted: an added or edited one waits (ADR 0020).
    for (const e of HOOK_EVENTS) {
      for (const h of commandHooks(json, e)) {
        const trusted = isTrusted(opts.dataDir, key, "hooks", hookItem(e, h));
        if (!trusted) heldBack = true;
        else if (e === event) hooks.push(h);
      }
    }
  }
  return { hooks, heldBack };
}

// ---- running ----

interface HookRun {
  hook: CommandHook;
  /** Set when the hook ran to the end. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  /** Why it failed: timed out, couldn't start, or exited with an error code. */
  failure?: string;
  json?: Json;
}

function substitute(s: string, projectDir: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder.
  return s.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir);
}

function runCommand(hook: CommandHook, input: Json, cwd: string, timeoutSec: number) {
  return new Promise<HookRun>((resolve) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
    const [file, argv] = hook.args
      ? [substitute(hook.command, cwd), hook.args.map((a) => substitute(a, cwd))]
      : ["/bin/sh", ["-c", hook.command]];
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (run: Omit<HookRun, "hook" | "stdout" | "stderr">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ hook, stdout, stderr, ...run });
    };
    const child = spawn(file, argv as string[], { cwd, env, detached: true, stdio: "pipe" });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({ failure: `timed out after ${timeoutSec}s` });
    }, timeoutSec * 1000);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_MAX) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_MAX) stderr += d.toString();
    });
    child.on("error", (err) => finish({ failure: `could not start: ${err.message}` }));
    child.on("close", (code, signal) => {
      if (code === null) return finish({ failure: `killed by ${signal ?? "a signal"}` });
      if (code !== 0 && code !== 2) return finish({ exitCode: code, failure: `exit code ${code}` });
      finish({ exitCode: code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

const cap = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function parseStdout(run: HookRun): HookRun {
  const out = run.stdout.trim();
  if (run.exitCode !== 0 || !out.startsWith("{")) return run;
  try {
    const parsed: unknown = JSON.parse(out);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...run, json: parsed as Json };
    }
  } catch {
    // Not one JSON object: plain text, as in Claude Code.
  }
  return run;
}

/** A run's verdict on blocking: exit 2 (stderr), `continue: false`, or a failure set to block. */
function blockOf(run: HookRun, label: string): string | undefined {
  if (run.exitCode === 2) return cap(run.stderr.trim()) || `blocked by ${label}`;
  if (run.failure && run.hook.blockOnFailure) return `${label} failed (${run.failure})`;
  if (run.json?.continue === false) return str(run.json.stopReason) ?? `stopped by ${label}`;
  return undefined;
}

const specific = (run: HookRun) => (run.json?.hookSpecificOutput as Json | undefined) ?? {};

/** Plain stdout or `additionalContext`: what the hook adds to the model's context. */
function contextOf(run: HookRun, plainCounts: boolean): string | undefined {
  if (run.exitCode !== 0) return undefined;
  const extra = str(specific(run).additionalContext) ?? str(run.json?.additionalContext);
  if (extra) return cap(extra);
  if (plainCounts && !run.json) return str(run.stdout.trim()) && cap(run.stdout.trim());
  return undefined;
}

const PRIORITY = { deny: 3, ask: 2, allow: 1 } as const;

export function createClaudeHooks(opts: ClaudeHooksOptions): ClaudeHooks {
  const log = opts.log ?? ((m: string) => console.error(`hamness hooks: ${m}`));

  async function fire(
    event: HookEvent,
    s: HookSession,
    matchValue: string | undefined,
    fields: Json,
  ): Promise<HookRun[]> {
    const { hooks } = loadHooks({ ...opts, log }, s.cwd, event);
    // Identical handlers run once (Claude Code dedupes matching handlers by command).
    const seen = new Set<string>();
    const matching = hooks.filter((h) => {
      if (!matcherMatches(h.matcher, matchValue) || seen.has(h.label)) return false;
      seen.add(h.label);
      return true;
    });
    if (matching.length === 0) return [];
    const input: Json = {
      session_id: s.sessionId,
      transcript_path: s.transcriptPath ?? "",
      cwd: s.cwd,
      permission_mode: s.permissionMode ?? "default",
      hook_event_name: event,
      ...fields,
    };
    const timeout = (h: CommandHook) => h.timeoutSec ?? TIMEOUT_SEC[event] ?? DEFAULT_TIMEOUT_SEC;
    const run = (h: CommandHook) =>
      runCommand(h, input, s.cwd, timeout(h)).then((r) => {
        if (r.failure) log(`${event} hook ${basename(h.label)}: ${r.failure}`);
        return parseStdout(r);
      });
    for (const h of matching.filter((h) => h.async)) void run(h);
    return Promise.all(matching.filter((h) => !h.async).map(run));
  }

  return {
    async preToolUse(s, call) {
      const { toolName, toolInput } = toClaudeCall(call.tool, call.args, s.cwd);
      const runs = await fire("PreToolUse", s, toolName, {
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: call.toolUseId,
      });
      let best: PreToolOutcome | undefined;
      for (const run of runs) {
        const label = `PreToolUse hook ${run.hook.label}`;
        const blocked = blockOf(run, label);
        const out = specific(run);
        const legacy = run.json?.decision;
        const decision = blocked
          ? "deny"
          : (out.permissionDecision ??
            (legacy === "approve" ? "allow" : legacy === "block" ? "deny" : undefined));
        if (decision !== "allow" && decision !== "ask" && decision !== "deny") continue;
        const reason =
          blocked ??
          str(out.permissionDecisionReason) ??
          str(run.json?.reason) ??
          `a PreToolUse hook said ${decision}`;
        if (!best || PRIORITY[decision] > PRIORITY[best.decision]) {
          best = { decision, reason: cap(reason), hook: run.hook.label };
        }
      }
      return best;
    },

    async postToolUse(s, call) {
      const { toolName, toolInput } = toClaudeCall(call.tool, call.args, s.cwd);
      const runs = await fire("PostToolUse", s, toolName, {
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toClaudeResponse(call.tool, call.args, call.output, s.cwd),
        tool_use_id: call.toolUseId,
      });
      const notes: string[] = [];
      for (const run of runs) {
        const blocked =
          blockOf(run, `PostToolUse hook ${run.hook.label}`) ??
          (run.json?.decision === "block" ? str(run.json.reason) : undefined);
        if (blocked) notes.push(cap(blocked));
        const extra = contextOf(run, false);
        if (extra) notes.push(extra);
      }
      return notes.length ? { context: notes.join("\n\n") } : {};
    },

    async userPromptSubmit(s, prompt) {
      const runs = await fire("UserPromptSubmit", s, undefined, { prompt });
      const context: string[] = [];
      for (const run of runs) {
        const blocked =
          blockOf(run, "a UserPromptSubmit hook") ??
          (run.json?.decision === "block"
            ? (str(run.json.reason) ?? "blocked by a UserPromptSubmit hook")
            : undefined);
        if (blocked) return { blocked };
        const extra = contextOf(run, true);
        if (extra) context.push(extra);
      }
      return context.length ? { context: context.join("\n\n") } : {};
    },

    async stop(s, info) {
      const runs = await fire("Stop", s, undefined, {
        stop_hook_active: info.stopHookActive,
        last_assistant_message: info.lastAssistantMessage,
        background_tasks: [],
        session_crons: [],
      });
      // `continue: false` ends the turn whatever the others say.
      if (runs.some((r) => r.json?.continue === false)) return {};
      const reasons: string[] = [];
      for (const run of runs) {
        const why =
          blockOf(run, "a Stop hook") ??
          (run.json?.decision === "block"
            ? (str(run.json.reason) ?? "a Stop hook asked to continue")
            : contextOf(run, false));
        if (why) reasons.push(cap(why));
      }
      return reasons.length ? { continueWith: reasons.join("\n\n") } : {};
    },

    async sessionStart(s, info) {
      const { heldBack } = loadHooks({ ...opts, log }, s.cwd, "SessionStart");
      const runs = await fire("SessionStart", s, info.source, {
        source: info.source,
        ...(info.model ? { model: info.model } : {}),
      });
      const context = runs.map((r) => contextOf(r, true)).filter((c): c is string => !!c);
      return {
        ...(context.length ? { context: context.join("\n\n") } : {}),
        ...(heldBack
          ? {
              notice: `This project's Claude Code hooks (.claude/settings*.json) are not trusted (new, or changed since you trusted them), so those don't run. Review them with \`hamness trust --show\`, then run \`hamness trust\` in ${projectRoot(s.cwd)}.`,
            }
          : {}),
      };
    },
  };
}
