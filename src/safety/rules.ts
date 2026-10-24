import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchCommand, matchPath } from "./glob.ts";
import { parseCommand, type Segment } from "./shell.ts";

/**
 * The rule engine: pure, no I/O. Given a tool call, the rules (defaults, then user config,
 * then project config) and where the session runs, it says allow / ask / deny, or
 * `undecided` when no rule speaks (the mode or the judge decides those).
 *
 * - Last match wins, except that a project rule never loosens an `ask` or `deny`
 *   from the defaults or the user config. A repo can't allow itself `sudo`.
 * - bash commands are split into their parts (see `shell.ts`); each part is checked and the
 *   strictest result wins: deny > ask > undecided > allow.
 */

export type RuleVerdict = "allow" | "ask" | "deny";
export type RuleLayer = "default" | "user" | "project";

export interface Rule {
  /** A glob on the tool name: `bash`, `{write,edit}`, `mcp__github__*`. */
  tool: string;
  /** A glob on the command (bash) or path (file tools); `*` for every call of other tools. */
  pattern: string;
  verdict: RuleVerdict;
  layer: RuleLayer;
}

export interface EvalContext {
  /** The session's working directory: `$CWD` in patterns, and the base for relative paths. */
  cwd: string;
  home: string;
  /** hamness's data dir: `$DATA` in patterns. */
  dataDir: string;
  /** Resolves symlinks, so a link can't smuggle a path past the rules. Optional (tests). */
  realpath?: (path: string) => string;
}

export interface Evaluation {
  verdict: RuleVerdict | "undecided";
  /** The rule behind the verdict, when one decided. */
  rule?: Rule;
  reason: string;
  /** What "allow always" would add to the project config. Empty when it is not offered. */
  suggestions: Rule[];
}

const RANK = { allow: 0, undecided: 1, ask: 2, deny: 3 } as const;

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const PATH_SAFE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** Commands whose words are a program: a wildcard after them would allow anything. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
  "npx",
  "bunx",
  "pnpx",
  "uvx",
  "eval",
  "exec",
  "env",
  "xargs",
  "ssh",
]);
const WRAPPERS = new Set(["env", "nohup", "time", "command", "builtin", "exec", "nice", "xargs"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

// ---------------------------------------------------------------------------------------------
// Config

const VERDICTS = new Set<string>(["allow", "ask", "deny"]);

/**
 * Reads a `permission` block: `{ <tool glob>: verdict | { <pattern>: verdict } }`, in file order.
 * Throws with the offending key on anything else.
 */
export function parsePermission(permission: unknown, layer: RuleLayer): Rule[] {
  if (permission === undefined) return [];
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    throw new Error("permission must be an object of tool: verdict or tool: { pattern: verdict }");
  }
  const rules: Rule[] = [];
  for (const [tool, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      if (!VERDICTS.has(value))
        throw new Error(`permission.${tool}: "${value}" is not allow, ask or deny`);
      rules.push({ tool, pattern: "*", verdict: value as RuleVerdict, layer });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`permission.${tool} must be a verdict or an object of pattern: verdict`);
    }
    for (const [pattern, v] of Object.entries(value)) {
      if (typeof v !== "string" || !VERDICTS.has(v)) {
        throw new Error(
          `permission.${tool}["${pattern}"]: ${JSON.stringify(v)} is not allow, ask or deny`,
        );
      }
      rules.push({ tool, pattern, verdict: v as RuleVerdict, layer });
    }
  }
  return rules;
}

/** `default rule bash "rm -rf *"`, for reasons and the audit log. */
export function describeRule(rule: Rule): string {
  return `${rule.layer} rule ${rule.tool} "${rule.pattern}"`;
}

// ---------------------------------------------------------------------------------------------
// Matching

type Part = {
  verdict: RuleVerdict | "undecided";
  rule?: Rule;
  reason: string;
  suggestion?: Rule | null;
};

const escapeGlob = (s: string) => s.replace(/[*?{},\\]/g, "\\$&");

function expandPathPattern(pattern: string, ctx: EvalContext): string {
  if (pattern === "*" || pattern === "**") return "**";
  if (pattern.startsWith("$CWD")) return escapeGlob(ctx.cwd) + pattern.slice(4);
  if (pattern.startsWith("$DATA")) return escapeGlob(ctx.dataDir) + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return escapeGlob(ctx.home) + pattern.slice(5);
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~{")) {
    return escapeGlob(ctx.home) + pattern.slice(1);
  }
  if (pattern.startsWith("/") || pattern.startsWith("**")) return pattern;
  return `${escapeGlob(ctx.cwd)}/${pattern}`;
}

/** The last matching rule, where a project rule can't loosen an ask/deny from below it. */
function lookup(
  rules: Rule[],
  tool: string,
  matches: (pattern: string) => boolean,
): Rule | undefined {
  let last: Rule | undefined;
  let lastBase: Rule | undefined;
  for (const rule of rules) {
    if (!matchCommand(rule.tool, tool) || !matches(rule.pattern)) continue;
    last = rule;
    if (rule.layer !== "project") lastBase = rule;
  }
  if (
    last?.layer === "project" &&
    lastBase &&
    lastBase.verdict !== "allow" &&
    RANK[lastBase.verdict] > RANK[last.verdict]
  ) {
    return lastBase;
  }
  return last;
}

/** Pi's `UNICODE_SPACES` (utils/paths.ts): read as plain spaces. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The file a Pi tool opens for a `path` argument: Pi's `resolveToCwd` exactly (unicode spaces
 * to spaces, `@` stripped, `~` expanded, `file://` URLs decoded, then resolved against the cwd;
 * no trimming). Throws when Pi would (a `file:` URL that is not a local path).
 */
export function piToolPath(raw: string, cwd: string, home: string): string {
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Pi's read tool also tries these when the path is missing (macOS screenshot names). */
function piReadVariants(path: string): string[] {
  const amPm = path.replace(/ (AM|PM)\./gi, "\u202F$1.");
  const nfd = path.normalize("NFD");
  const curly = (p: string) => p.replace(/'/g, "\u2019");
  return [...new Set([amPm, nfd, curly(path), curly(nfd)])].filter((p) => p !== path);
}

/** A path word in a shell command: the shell expands `~` and `$HOME`; relative to the cwd. */
function shellPath(raw: string, ctx: EvalContext): string {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = ctx.home;
  else if (p.startsWith("~/")) p = ctx.home + p.slice(1);
  else if (p.startsWith("$HOME/") || p === "$HOME") p = ctx.home + p.slice(5);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's literal ${HOME}.
  else if (p.startsWith("${HOME}/") || p === "${HOME}") p = ctx.home + p.slice(7);
  return normalize(isAbsolute(p) ? p : resolve(ctx.cwd, p));
}

/** Shows a path the way a config file should hold it: `$CWD/...`, `~/...` or absolute. */
function portable(path: string, ctx: EvalContext): string {
  if (path === ctx.cwd || path.startsWith(`${ctx.cwd}/`))
    return `$CWD${escapeGlob(path.slice(ctx.cwd.length))}`;
  if (path === ctx.home || path.startsWith(`${ctx.home}/`))
    return `~${escapeGlob(path.slice(ctx.home.length))}`;
  return escapeGlob(path);
}

function pathSuggestion(tool: string, path: string, ctx: EvalContext): Rule {
  const dir = dirname(path);
  // Never suggest a whole home, root, or a folder that holds the workspace.
  const tooBroad =
    dir === "/" || dir === ctx.home || ctx.cwd === dir || ctx.cwd.startsWith(`${dir}/`);
  const pattern = tooBroad ? portable(path, ctx) : `${portable(dir, ctx)}/**`;
  return { tool, pattern, verdict: "allow", layer: "project" };
}

/** Checks the file a tool's path argument opens (see `piToolPath`). */
function checkToolPath(tool: string, raw: string, rules: Rule[], ctx: EvalContext): Part {
  let path: string;
  try {
    path = piToolPath(raw, ctx.cwd, ctx.home);
  } catch (err) {
    return {
      verdict: "deny",
      reason: `could not resolve the path ${JSON.stringify(raw)} (${(err as Error).message})`,
      suggestion: null,
    };
  }
  const paths = tool === "read" ? [path, ...piReadVariants(path)] : [path];
  return worstOf(paths.map((p) => checkResolved(tool, p, rules, ctx)));
}

function checkPath(tool: string, raw: string, rules: Rule[], ctx: EvalContext): Part {
  return checkResolved(tool, shellPath(raw, ctx), rules, ctx);
}

function checkResolved(tool: string, lexical: string, rules: Rule[], ctx: EvalContext): Part {
  const candidates: Array<[string, EvalContext]> = [[lexical, ctx]];
  const real = ctx.realpath?.(lexical);
  if (real && ctx.realpath && real !== lexical) {
    // The real path is compared with the real workspace (on macOS /var is /private/var).
    const rp = ctx.realpath;
    candidates.push([real, { cwd: rp(ctx.cwd), home: rp(ctx.home), dataDir: rp(ctx.dataDir) }]);
  }

  let worst: Part | undefined;
  for (const [path, c] of candidates) {
    const rule = lookup(rules, tool, (p) => matchPath(expandPathPattern(p, c), path));
    const part: Part = rule
      ? {
          verdict: rule.verdict,
          rule,
          reason: `${verbFor(rule.verdict)} by ${describeRule(rule)} for ${path}`,
        }
      : {
          verdict: "undecided",
          reason: `no rule matches ${tool} ${path}`,
          suggestion: pathSuggestion(tool, path, c),
        };
    if (!worst || RANK[part.verdict] > RANK[worst.verdict]) worst = part;
  }
  return worst as Part;
}

const verbFor = (v: RuleVerdict) => (v === "allow" ? "allowed" : v === "deny" ? "denied" : "asked");

// ---------------------------------------------------------------------------------------------
// bash

/** Strips env assignments and wrapper commands (`env`, `timeout 5`, `xargs -0`, ...). */
function unwrap(words: string[]): { words: string[]; wrapped: boolean } {
  let w = [...words];
  let wrapped = false;
  for (;;) {
    const before = w.length;
    while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const head = w[0];
    if (head && WRAPPERS.has(head)) {
      w = w.slice(1);
      while (
        w[0] &&
        (w[0].startsWith("-") || (head === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])))
      ) {
        w = w.slice(1);
      }
    } else if (head === "timeout") {
      w = w.slice(1);
      while (w[0]?.startsWith("-")) w = w.slice(1);
      w = w.slice(1);
    }
    if (w.length === before) break;
    wrapped = true;
  }
  return { words: w, wrapped };
}

function commandSuggestion(words: string[]): Rule {
  const [w0 = "", w1] = words;
  let pattern: string;
  if (INTERPRETERS.has(w0)) pattern = words.map(escapeGlob).join(" ");
  else if (w1 && /^[a-z][\w:-]*$/.test(w1)) pattern = `${escapeGlob(w0)} ${escapeGlob(w1)} *`;
  else pattern = `${escapeGlob(w0)} *`;
  return { tool: "bash", pattern, verdict: "allow", layer: "project" };
}

function worstOf(parts: Part[]): Part {
  return parts.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
}

function checkBash(command: string, rules: Rule[], ctx: EvalContext, depth = 0): Part[] {
  const parsed = parseCommand(command);
  if (!parsed.ok) {
    return [
      { verdict: "ask", reason: `could not check the command (${parsed.error})`, suggestion: null },
    ];
  }
  if (depth > 3)
    return [{ verdict: "ask", reason: "commands nested too deep to check", suggestion: null }];

  const bashRules = rules.filter((r) => !r.pattern.includes(" | "));
  const pipeRules = rules.filter((r) => r.pattern.includes(" | "));
  const parts: Part[] = [];

  for (const seg of parsed.segments) parts.push(...checkSegment(seg, bashRules, rules, ctx, depth));

  // Pipeline rules (a pattern with ` | `) match whole pipe chains, e.g. `curl ... | sh`.
  if (pipeRules.length > 0) {
    const chains: string[] = [];
    let chain: Segment[] = [];
    const flush = () => {
      if (chain.length > 1)
        chains.push(chain.map((s) => unwrap(s.words).words.join(" ")).join(" | "));
      chain = [];
    };
    for (const seg of parsed.segments) {
      if (!seg.pipedFrom) flush();
      chain.push(seg);
    }
    flush();
    for (const text of chains) {
      const rule = lookup(pipeRules, "bash", (p) => matchCommand(p, text));
      if (rule && rule.verdict !== "allow") {
        parts.push({
          verdict: rule.verdict,
          rule,
          reason: `${verbFor(rule.verdict)} by ${describeRule(rule)} for \`${text}\``,
        });
      }
    }
  }
  return parts;
}

function checkSegment(
  seg: Segment,
  bashRules: Rule[],
  rules: Rule[],
  ctx: EvalContext,
  depth: number,
): Part[] {
  const parts: Part[] = [];
  const { words, wrapped } = unwrap(seg.words);
  const text = words.join(" ");
  const shown = seg.words.join(" ");

  if (words.length > 0) {
    const outer = parts.length;
    const rule = lookup(bashRules, "bash", (p) => matchCommand(p, text));
    if (rule && !(rule.verdict === "allow" && (seg.dynamic || wrapped))) {
      parts.push({
        verdict: rule.verdict,
        rule,
        reason: `${verbFor(rule.verdict)} by ${describeRule(rule)} for \`${shown}\``,
      });
    } else if (rule) {
      const why = seg.dynamic
        ? "uses variables or substitutions"
        : "runs through a wrapper or env assignment";
      parts.push({
        verdict: "undecided",
        reason: `\`${shown}\` ${why}, so no rule can allow it`,
        suggestion: null,
      });
    } else {
      parts.push({
        verdict: "undecided",
        reason: `no rule matches \`${shown}\``,
        suggestion: seg.dynamic || wrapped ? null : commandSuggestion(words),
      });
    }

    // A shell's -c string and eval's words run too: check them as commands.
    const [head = "", ...rest] = words;
    let inner: string | undefined;
    if (SHELLS.has(head)) {
      const flag = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
      if (flag >= 0) inner = rest[flag + 1];
    } else if (head === "eval") {
      inner = rest.join(" ");
    }
    if (inner !== undefined) {
      const innerParts = checkBash(inner, rules, ctx, depth + 1);
      // The shell itself is never allowed outright.
      const own = parts[outer];
      if (own?.verdict === "allow") {
        parts[outer] = {
          verdict: "undecided",
          reason: `\`${shown}\` runs another command`,
          suggestion: null,
        };
      }
      parts.push(...innerParts);
    }

    // Words that name secret files deny the command (`cat .env`). Only denies count here.
    for (const word of words.slice(1)) {
      const path = word.replace(/[*?[\]{}]/g, "");
      if (!path || path.startsWith("-")) continue;
      const p = checkPath("read", path, rules, ctx);
      if (p.verdict === "deny") parts.push(p);
    }
  }

  for (const r of seg.redirects) {
    if (r.target.includes("$(…)") || r.target.startsWith("$")) {
      parts.push({
        verdict: "undecided",
        reason: `redirects to a computed path \`${r.target}\``,
        suggestion: null,
      });
      continue;
    }
    const target = shellPath(r.target, ctx);
    if (PATH_SAFE.has(target) || target.startsWith("/dev/fd/")) continue;
    parts.push(checkPath(r.op === "<" ? "read" : "write", r.target, rules, ctx));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------

function subjectPath(args: Record<string, unknown>): string | undefined {
  const p = args.path ?? args.file_path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

export function evaluate(
  call: { tool: string; args: Record<string, unknown> },
  rules: Rule[],
  ctx: EvalContext,
): Evaluation {
  let parts: Part[];
  if (call.tool === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command : "";
    parts = command.trim()
      ? checkBash(command, rules, ctx)
      : [{ verdict: "ask", reason: "bash without a command", suggestion: null }];
  } else if (READ_TOOLS.has(call.tool) || WRITE_TOOLS.has(call.tool)) {
    const path = subjectPath(call.args) ?? (READ_TOOLS.has(call.tool) ? ctx.cwd : undefined);
    parts = path
      ? [checkToolPath(call.tool, path, rules, ctx)]
      : [{ verdict: "ask", reason: `${call.tool} without a path`, suggestion: null }];
  } else {
    const rule = lookup(rules, call.tool, (p) => p === "*" || p === "**");
    parts = [
      rule
        ? {
            verdict: rule.verdict,
            rule,
            reason: `${verbFor(rule.verdict)} by ${describeRule(rule)}`,
          }
        : {
            verdict: "undecided",
            reason: `no rule matches the tool ${call.tool}`,
            suggestion: {
              tool: escapeGlob(call.tool),
              pattern: "*",
              verdict: "allow",
              layer: "project",
            },
          },
    ];
  }

  const worst = worstOf(parts);
  const undecided = parts.filter((p) => p.verdict === "undecided");
  const offerAlways =
    worst.verdict === "undecided" && undecided.every((p) => p.suggestion) && undecided.length > 0;
  const suggestions: Rule[] = [];
  if (offerAlways) {
    for (const p of undecided) {
      const s = p.suggestion as Rule;
      if (!suggestions.some((x) => x.tool === s.tool && x.pattern === s.pattern))
        suggestions.push(s);
    }
  }
  return {
    verdict: worst.verdict,
    ...(worst.rule ? { rule: worst.rule } : {}),
    reason: worst.reason,
    suggestions,
  };
}
