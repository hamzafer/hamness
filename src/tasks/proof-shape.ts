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

/** Flags that make a test runner, build or linter print and exit without checking. */
const INFO_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--dry-run",
  "--list",
  "--list-tests",
  "--collect-only",
  "--co",
  "--passWithNoTests",
  "--pass-with-no-tests",
  "--listTests",
  "--showConfig",
]);

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
  const info = rest.find((w) => INFO_FLAGS.has(w));
  if (info) return `\`${info}\` only prints information; it checks nothing`;

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
