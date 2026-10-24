import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
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

/** The proof gate's own checks (ADR 0019): a `prove` command re-run and a `prove` URL fetch. */
export const PROVE_COMMAND = "prove_command";
export const PROVE_URL = "prove_url";
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
  /**
   * Expands a shell glob (an absolute pattern) to the paths it matches now; undefined when it
   * can't (too many matches). Without it, a command with a glob is never allowed outright.
   */
  glob?: (pattern: string) => string[] | undefined;
  /**
   * The session's filesystem ignores case (macOS by default), so `.MCP.json` is `.mcp.json`:
   * path rules match in any case (V-M4).
   */
  caseInsensitive?: boolean;
  /**
   * The files a recursive read under `root` would open (V-M5): `ignore` honours .gitignore and
   * the like (rg's default), `hidden` includes dot files. Undefined: too many to list.
   * Without it, only deny rules with a fixed folder are checked against recursive reads.
   */
  listFiles?: (root: string, opts: ListOptions) => string[] | undefined;
}

export interface ListOptions {
  ignore: boolean;
  hidden: boolean;
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
  // At `/`, `$CWD/x` is `/x`, not `//x`.
  const cwd = ctx.cwd === "/" ? "" : escapeGlob(ctx.cwd);
  if (pattern.startsWith("$CWD")) return cwd + pattern.slice(4);
  if (pattern.startsWith("$DATA")) return escapeGlob(ctx.dataDir) + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return escapeGlob(ctx.home) + pattern.slice(5);
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~{")) {
    return escapeGlob(ctx.home) + pattern.slice(1);
  }
  if (pattern.startsWith("/") || pattern.startsWith("**")) return pattern;
  return `${cwd}/${pattern}`;
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
    candidates.push([
      real,
      {
        cwd: rp(ctx.cwd),
        home: rp(ctx.home),
        dataDir: rp(ctx.dataDir),
        ...(ctx.caseInsensitive ? { caseInsensitive: true } : {}),
      },
    ]);
  }

  let worst: Part | undefined;
  for (const [path, c] of candidates) {
    const rule = lookup(rules, tool, (p) =>
      matchPath(expandPathPattern(p, c), path, c.caseInsensitive === true),
    );
    const part: Part =
      rule?.verdict === "allow" && rule.pattern.startsWith("$CWD") && broadWorkspace(c.cwd, c.home)
        ? {
            verdict: "ask",
            reason: `the session runs in your home folder or /, so ${describeRule(rule)} does not allow ${path}`,
            suggestion: null,
          }
        : rule
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

/**
 * A session dir too broad for `$CWD` rules to mean "the project": the home folder or `/`.
 * There, `$CWD/**` would allow writing `~/.zshrc`, so those rules ask instead.
 */
export function broadWorkspace(cwd: string, home: string): boolean {
  const dir = resolve(cwd);
  return dir === "/" || dir === resolve(home);
}

const verbFor = (v: RuleVerdict) => (v === "allow" ? "allowed" : v === "deny" ? "denied" : "asked");

// ---------------------------------------------------------------------------------------------
// bash

/** Strips env assignments and wrapper commands (`env`, `timeout 5`, `xargs -0`, ...). */
export function unwrap(words: string[]): { words: string[]; wrapped: boolean } {
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

/**
 * The rule for a command's words. A command run by its path (`/usr/bin/sudo`) also meets the
 * ask and deny rules for its bare name; an allow for the bare name never applies to a path.
 */
function commandRule(bashRules: Rule[], words: string[]): Rule | undefined {
  const rule = lookup(bashRules, "bash", (p) => matchCommand(p, words.join(" ")));
  const head = words[0] ?? "";
  if (!head.includes("/")) return rule;
  const bare = [basename(head), ...words.slice(1)].join(" ");
  const byName = lookup(bashRules, "bash", (p) => matchCommand(p, bare));
  if (!byName || byName.verdict === "allow") return rule;
  const rank = (r: Rule | undefined) => (r ? RANK[r.verdict] : RANK.undecided);
  return rank(byName) > rank(rule) ? byName : rule;
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
  if (parts.length === 0) return { verdict: "ask", reason: "nothing to check", suggestion: null };
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
  const unwrapped = unwrap(seg.words);
  // `env` or `nohup` alone (or only assignments) is a command too: `env` prints the environment.
  const words = unwrapped.words.length > 0 ? unwrapped.words : seg.words;
  const wrapped = unwrapped.wrapped;
  const shown = seg.words.join(" ");

  if (words.length > 0) {
    const outer = parts.length;
    const rule = commandRule(bashRules, words);
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
    const [path = "", ...rest] = words;
    const head = basename(path);
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
      if (isGlob(word)) parts.push(...checkGlob(word, rules, ctx));
    }

    // A recursive read (`grep -r`, `rg`, `find`) over a folder that holds denied paths asks.
    for (const root of recursiveRoots(words, ctx)) {
      const denied = deniedInside("read", root, rules, ctx);
      if (denied) parts.push(recursivePart(shown, denied));
    }
    // One that reads contents (`grep -r`, `rg`, `ag`) over denied files asks too (V-M5).
    for (const { root, opts } of contentRoots(words, ctx)) {
      const part = deniedFilePart(shown, root, opts, rules, ctx);
      if (part) parts.push(part);
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
// Globs and recursive reads

const isGlob = (word: string) => /[*?[]/.test(word) || /\{[^}]*,[^}]*\}/.test(word);

/** A glob word: every path it matches must pass the secret check, or the command can't be allowed. */
function checkGlob(word: string, rules: Rule[], ctx: EvalContext): Part[] {
  const pattern = shellPath(word, ctx);
  const matches = ctx.glob?.(pattern);
  if (!matches) {
    return [
      {
        verdict: "undecided",
        reason: `\`${word}\` is a glob ${ctx.glob ? "with too many matches to check" : "hamness can't expand here"}, so no rule can allow it`,
        suggestion: null,
      },
    ];
  }
  return matches
    .map((m) => checkResolved("read", m, rules, ctx))
    .filter((p) => p.verdict === "deny");
}

const ALWAYS_RECURSIVE = new Set(["rg", "find", "fd", "tree", "ag", "du"]);
/** Commands whose first word after the flags is a pattern, not a path. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "fd"]);

/** The folders a recursive read command walks; empty when it does not recurse. */
function recursiveRoots(words: string[], ctx: EvalContext): string[] {
  const head = basename(words[0] ?? "");
  const rest = words.slice(1);
  const flags = rest.filter((w) => w.startsWith("-"));
  const recursive =
    ALWAYS_RECURSIVE.has(head) ||
    (["grep", "egrep", "fgrep"].includes(head) &&
      flags.some((f) => /^-[A-Za-z]*[rR]/.test(f) || /^--(dereference-)?recursive$/.test(f))) ||
    (head === "ls" && flags.some((f) => /^-[A-Za-z]*R/.test(f) || f === "--recursive"));
  if (!recursive) return [];
  const operands = rest.filter((w) => !w.startsWith("-") && !w.includes("$(…)"));
  const paths = PATTERN_FIRST.has(head) ? operands.slice(1) : operands;
  return (paths.length > 0 ? paths : ["."]).map((p) => shellPath(p, ctx));
}

/**
 * The folders a command reads every file of, and which files it opens: `grep -r` all of them,
 * `rg` and `ag` skip ignored and hidden files unless their flags say otherwise.
 */
function contentRoots(
  words: string[],
  ctx: EvalContext,
): Array<{ root: string; opts: ListOptions }> {
  const head = basename(words[0] ?? "");
  const rest = words.slice(1);
  const flags = rest.filter((w) => w.startsWith("-") && w !== "-" && w !== "--");
  let opts: ListOptions;
  if (["grep", "egrep", "fgrep"].includes(head)) {
    const recursive = flags.some(
      (f) => /^-[A-Za-z]*[rR]/.test(f) || /^--(dereference-)?recursive$/.test(f),
    );
    if (!recursive) return [];
    opts = { ignore: false, hidden: true };
  } else if (head === "rg" || head === "ag") {
    const u = flags
      .filter((f) => /^-[A-Za-z]*u/.test(f) && !f.startsWith("--"))
      .reduce((n, f) => n + (f.match(/u/g)?.length ?? 0), 0);
    const unrestricted = flags.filter((f) => f === "--unrestricted").length;
    const level = u + unrestricted;
    opts = {
      ignore: !(
        level >= 1 || flags.some((f) => /^--no-ignore/.test(f) || f === "--skip-vcs-ignores")
      ),
      hidden:
        (head === "ag" ? level >= 1 : level >= 2) ||
        flags.some((f) => f === "--hidden" || f === "-." || /^-[A-Za-z]*\.$/.test(f)),
    };
  } else {
    return [];
  }
  const operands = rest.filter((w) => !w.startsWith("-") && !w.includes("$(…)"));
  const paths = operands.slice(1);
  return (paths.length > 0 ? paths : ["."]).map((p) => ({ root: shellPath(p, ctx), opts }));
}

/** Reading every file `listFiles` gives under `root`: ask when one is denied. */
function deniedFilePart(
  what: string,
  root: string,
  opts: ListOptions,
  rules: Rule[],
  ctx: EvalContext,
): Part | undefined {
  if (!ctx.listFiles) return undefined;
  const files = ctx.listFiles(root, opts);
  if (!files) {
    return {
      verdict: "undecided",
      reason: `\`${what}\` reads more files than hamness can check, so no rule can allow it`,
      suggestion: null,
    };
  }
  // Each file against the read rules, without resolving links (the walk does not follow them).
  const plain: EvalContext = {
    cwd: ctx.cwd,
    home: ctx.home,
    dataDir: ctx.dataDir,
    ...(ctx.caseInsensitive ? { caseInsensitive: true } : {}),
  };
  const denied = files.find((f) => checkResolved("read", f, rules, plain).verdict === "deny");
  return denied ? recursivePart(what, denied) : undefined;
}

/** Unescapes a pattern's fixed start (before any wildcard): the folder or file it names. */
function fixedPrefix(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      out += pattern[++i] ?? "";
      continue;
    }
    if ("*?{[".includes(c)) break;
    out += c;
  }
  return out.replace(/\/+$/, "");
}

/** A denied path under `root` (a deny rule's fixed start inside it), for recursive reads. */
function deniedInside(
  tool: string,
  root: string,
  rules: Rule[],
  ctx: EvalContext,
): string | undefined {
  const roots = [root];
  const real = ctx.realpath?.(root);
  if (real && real !== root) roots.push(real);
  const fold = (p: string) => (ctx.caseInsensitive ? p.toLowerCase() : p);
  for (const rule of rules) {
    if (rule.verdict !== "deny" || !matchCommand(rule.tool, tool)) continue;
    const prefix = fixedPrefix(expandPathPattern(rule.pattern, ctx));
    if (!prefix.startsWith("/")) continue; // `**/.env`: anywhere, checked file by file
    const p = fold(prefix);
    for (const raw of roots) {
      const r = fold(raw);
      if (r === "/" || p === r || p.startsWith(`${r}/`)) return prefix;
    }
  }
  return undefined;
}

const recursivePart = (what: string, denied: string): Part => ({
  verdict: "ask",
  reason: `\`${what}\` searches a folder that holds ${denied}, which is denied`,
  suggestion: null,
});

// ---------------------------------------------------------------------------------------------

/**
 * A `prove` URL fetch: patterns are command globs on the URL without user info
 * (`https://example.com/*`). "Allow always" offers the URL's origin.
 */
function checkUrl(raw: string, rules: Rule[]): Part {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { verdict: "ask", reason: "not a valid URL", suggestion: null };
  }
  const text = `${url.origin}${url.pathname}${url.search}`;
  const rule = lookup(rules, PROVE_URL, (p) => matchCommand(p, text));
  if (rule) {
    return {
      verdict: rule.verdict,
      rule,
      reason: `${verbFor(rule.verdict)} by ${describeRule(rule)} for ${text}`,
    };
  }
  return {
    verdict: "undecided",
    reason: `no rule allows fetching ${text}`,
    suggestion: {
      tool: PROVE_URL,
      pattern: `${escapeGlob(url.origin)}/*`,
      verdict: "allow",
      layer: "project",
    },
  };
}

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
  } else if (call.tool === PROVE_URL) {
    parts = [checkUrl(typeof call.args.url === "string" ? call.args.url : "", rules)];
  } else if (READ_TOOLS.has(call.tool) || WRITE_TOOLS.has(call.tool)) {
    const path = subjectPath(call.args) ?? (READ_TOOLS.has(call.tool) ? ctx.cwd : undefined);
    parts = path
      ? [checkToolPath(call.tool, path, rules, ctx)]
      : [{ verdict: "ask", reason: `${call.tool} without a path`, suggestion: null }];
    // grep and find walk the folder: one that holds denied paths asks.
    if (path && (call.tool === "grep" || call.tool === "find")) {
      let root: string | undefined;
      try {
        root = piToolPath(path, ctx.cwd, ctx.home);
      } catch {
        root = undefined;
      }
      const denied = root && deniedInside(call.tool, root, rules, ctx);
      if (denied) parts.push(recursivePart(`${call.tool} ${path}`, denied));
      // Pi's grep runs rg with --hidden, honouring ignore files: it reads what that lists.
      // (find only lists names, so it is not checked file by file.)
      if (root && call.tool === "grep") {
        const part = deniedFilePart(
          `grep ${path}`,
          root,
          { ignore: true, hidden: true },
          rules,
          ctx,
        );
        if (part) parts.push(part);
      }
    }
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
