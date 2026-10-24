import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { unwrap } from "../safety/rules.ts";
import { parseCommand, type Segment } from "../safety/shell.ts";

/**
 * Whether a command can prove anything at all (ADR 0019). Pure: it reads the command, it runs
 * nothing. A command passes when its exit code is the exit code of a real check:
 *
 * - Only `&&` and `|` join commands (pipes run with `pipefail`). `||`, `;`, newlines and `&`
 *   can turn a failing check into exit 0, so they are refused, as is `!`.
 * - No words known only at run time (`$VAR`, `$(...)`): hamness can't tell what would run.
 * - No no-ops that set the exit code (`true`, `:`, `exit`, `set`, `trap`), and no flags that
 *   only print information (`--help`, `--version`, `--collect-only`...).
 * - At least one part is more than a read-only or printing command (`echo`, `cat`, `ls`,
 *   `grep`, `git status`...): those prove nothing about the work.
 *
 * Whether a command that passes this may run without asking is the safety service's call
 * (the proof command list); this only refuses what could never be evidence.
 */

/** Commands that set the exit code without checking anything. */
const NO_OPS = new Set([
  "true",
  ":",
  "exit",
  "return",
  "set",
  "trap",
  "shopt",
  "!",
  "export",
  "unset",
  "alias",
]);

/** Commands that only read or print: harmless next to a check, but never one. */
const INERT = new Set([
  "echo",
  "printf",
  "cd",
  "pushd",
  "popd",
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "type",
  "stat",
  "tree",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "test",
  "[",
  "[[",
  "sleep",
  "date",
  "whoami",
  "env",
  "file",
  "less",
  "more",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "jq",
  "find",
  "du",
  "df",
]);
const INERT_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files"]);

/**
 * No-op flags (V-M2): flags that make a test runner, build or linter print, skip, or exit 0
 * without checking. A denylist per runner rather than an allowlist of flag shapes: real checks
 * take too many legitimate flags to list, and what slips through (a filter that matches
 * nothing) is mostly caught at run time by the "no tests ran" check. `--flag=value` is read
 * as `--flag`, every word counts (also after `--`), and `--passWithNoTests` in any spelling.
 */
const ANY_RUNNER = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--dry-run",
  "--list",
  "--list-tests",
  "--listTests",
  "--collect-only",
  "--co",
  "--showConfig",
  "--show-config",
  "--print-config",
  "--env-info",
  "--if-present",
  "--exit-zero",
  "--no-error-on-unmatched-pattern",
  "--no-errors-on-unmatched",
  "--permit-no-files",
]);

/** Flags that pick which tests run: a value that obviously matches nothing runs nothing. */
const FILTER_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "--testPathPattern",
  "--test-path-pattern",
  "-k",
  "-run",
  "--run",
  "--filter",
  "--grep",
  "-g",
]);
/** Flags that skip the tests they match: a value that matches everything skips them all. */
const SKIP_FLAGS = new Set(["--skip", "-skip", "--exclude"]);

const selectsNothing = (v: string) => /^\s*$|^\^\$$|^\$\^$|^\(\?!\)$|^\^\\b\$$/.test(v);
const matchesAll = (v: string) => /^\s*$|^\.\*?$|^\*$|^\.\+$/.test(v);

type Policy = {
  /** Flags (already without `=value`) that are no-ops for this runner. */
  flags?: ReadonlySet<string>;
  /** Short options that can be clustered (`make -ik`): any of these letters refuses. */
  cluster?: RegExp;
  /** Any other word test (maven's -D properties, mix's --exclude test). */
  word?: (word: string, next: string | undefined) => boolean;
};

const POLICIES: Record<string, Policy> = {
  tsc: {
    flags: new Set(["-v", "--init", "--noCheck", "--clean", "--listFilesOnly", "--all"]),
  },
  make: {
    flags: new Set([
      "--ignore-errors",
      "--touch",
      "--just-print",
      "--recon",
      "--keep-going",
      "--question",
    ]),
    cluster: /^-[A-Za-z]*[iknqt][A-Za-z]*$/,
  },
  go: {
    flags: new Set(["-exec", "-toolexec", "-n", "-list"]),
  },
  mvn: {
    flags: new Set(["-fn", "--fail-never"]),
    word: (w) =>
      /^-D(?:skipTests|maven\.test\.skip|maven\.test\.failure\.ignore|testFailureIgnore|surefire\.skip|failIfNoTests|surefire\.failIfNoSpecifiedTests|skip)\b/.test(
        w,
      ),
  },
  gradle: { flags: new Set(["-x", "--exclude-task", "-m"]) },
  pytest: {
    flags: new Set([
      "--fixtures",
      "--funcargs",
      "--fixtures-per-test",
      "--setup-plan",
      "--setup-only",
      "--markers",
    ]),
  },
  cargo: { flags: new Set(["--no-run"]) },
  mix: { word: (w, next) => w === "--exclude" && next === "test" },
};

/** The runner a command's words start: launchers (`npx`, `python -m`, `uv run`) stripped. */
function runnerOf(words: string[]): string {
  let w = words;
  for (;;) {
    const head = w[0] ?? "";
    if (["npx", "bunx", "pnpx"].includes(head)) w = w.slice(1);
    else if ((head === "pnpm" || head === "yarn") && ["exec", "dlx"].includes(w[1] ?? ""))
      w = w.slice(2);
    else if (head === "uv" && w[1] === "run") w = w.slice(2);
    else if (/^python3?$/.test(head) && w[1] === "-m") w = w.slice(2);
    else break;
  }
  const head = basename(w[0] ?? "");
  return head === "gradlew" ? "gradle" : head;
}

/** A no-op flag in a check's words, or undefined. */
function noOpFlag(words: string[]): string | undefined {
  const runner = runnerOf(words);
  const policy = POLICIES[runner] ?? {};
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string;
    const next = rest[i + 1];
    if (/pass-?with-?no-?tests/i.test(word)) return word;
    if (!word.startsWith("-")) continue;
    const eq = word.indexOf("=");
    let flag = eq > 0 ? word.slice(0, eq) : word;
    const value = eq > 0 ? word.slice(eq + 1) : next;
    // Go reads -flag and --flag alike.
    if (runner === "go" && flag.startsWith("--")) flag = flag.slice(1);
    if (ANY_RUNNER.has(flag) || policy.flags?.has(flag)) return word;
    if (policy.cluster && !flag.startsWith("--") && policy.cluster.test(flag)) return word;
    if (policy.word?.(word, next)) return `${word}${next && eq < 0 ? ` ${next}` : ""}`;
    if (value !== undefined && FILTER_FLAGS.has(flag) && selectsNothing(value)) {
      return `${flag} ${JSON.stringify(value)}`;
    }
    if (value !== undefined && SKIP_FLAGS.has(flag) && matchesAll(value)) {
      return `${flag} ${JSON.stringify(value)}`;
    }
  }
  return undefined;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Why `command` can't be evidence, or undefined when it can. */
export function proofCommandProblem(command: string, depth = 0): string | undefined {
  // A trailing `;` or newline ends the command; it hides nothing.
  const text = command.trim().replace(/[;\s]+$/, "");
  const parsed = parseCommand(text);
  if (!parsed.ok) return `hamness could not read the command (${parsed.error})`;

  for (const op of ["||", ";", "&"] as const) {
    if (parsed.operators.includes(op)) {
      const shown = op === ";" ? "; or a new line" : op;
      return `\`${shown}\` can hide a failing exit code; join commands with && only`;
    }
  }

  let checks = 0;
  for (const seg of parsed.segments) {
    const problem = segmentProblem(seg, depth);
    if (typeof problem === "string") return problem;
    if (problem) checks += 1;
  }
  if (checks === 0) {
    return "it proves nothing: it only reads or prints. Prove with a test, build, lint or typecheck command";
  }
  return undefined;
}

/** A reason to refuse, true when the segment is a real check, false when it is inert. */
function segmentProblem(seg: Segment, depth: number): string | boolean {
  if (seg.dynamic) {
    return `\`${seg.words.join(" ")}\` uses words known only at run time ($VAR or $(...)); write them out`;
  }
  if (seg.words[0] === "!") return "`!` turns a failure into a pass";
  const { words } = unwrap(seg.words);
  const [head = "", ...rest] = words;
  if (!head) return false;
  if (NO_OPS.has(head))
    return `\`${head}\` proves nothing: it sets the exit code without checking anything`;
  const noOp = noOpFlag(words);
  if (noOp) return `\`${noOp}\` makes it print, skip or pass without checking; it checks nothing`;

  if (SHELLS.has(head)) {
    const flag = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    const inner = flag >= 0 ? rest[flag + 1] : undefined;
    if (inner !== undefined) {
      if (depth >= 2) return "commands nested too deep to check";
      const problem = proofCommandProblem(inner, depth + 1);
      return problem ?? true;
    }
    return true;
  }
  if (INERT.has(head)) return false;
  if (head === "git" && INERT_GIT.has(rest[0] ?? "")) return false;
  return true;
}

/** True when the command has a pipe, so its re-run needs `pipefail`. */
export function hasPipe(command: string): boolean {
  const parsed = parseCommand(command.trim());
  return parsed.ok && parsed.operators.includes("|");
}

/** Resolves symlinks in the longest existing part of a path (the rest may not exist yet). */
function realNearest(path: string): string {
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

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/**
 * Why `command` leaves the session folder with `cd` / `pushd` (V-M3), or undefined. A check
 * run elsewhere is not about this work, so `cd` must land inside `cwd` (symlinks resolved);
 * `cd` alone, `cd ~` and `cd -` are refused. A shell's -c string is looked into.
 */
export function cdOutsideProblem(
  command: string,
  cwd: string,
  home: string,
  depth = 0,
): string | undefined {
  const parsed = parseCommand(command.trim().replace(/[;\s]+$/, ""));
  if (!parsed.ok) return undefined; // proofCommandProblem refuses it
  const root = realNearest(resolve(cwd));
  let dir = root;
  for (const seg of parsed.segments) {
    const { words } = unwrap(seg.words);
    const [head = "", ...rest] = words;
    if (head === "cd" || head === "pushd") {
      const target = rest.find((w) => !/^-[LPe@]+$/.test(w));
      const shown = `\`${words.join(" ")}\``;
      if (target === undefined || target === "-" || /^[+-]\d+$/.test(target)) {
        return `${shown} leaves the session folder: a check must run inside the session folder`;
      }
      const expanded =
        target === "~" ? home : target.startsWith("~/") ? join(home, target.slice(2)) : target;
      const next = realNearest(resolve(dir, expanded));
      if (!within(next, root)) {
        return `${shown} goes outside the session folder: a check must run inside it`;
      }
      dir = next;
      continue;
    }
    if (SHELLS.has(head)) {
      const flag = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
      const inner = flag >= 0 ? rest[flag + 1] : undefined;
      if (inner !== undefined && depth < 2) {
        const problem = cdOutsideProblem(inner, dir, home, depth + 1);
        if (problem) return problem;
      }
    }
  }
  return undefined;
}
