import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCommand } from "../safety/shell.ts";

/**
 * Whether a bash command writes files in the session folder, and which, for the proof rules
 * (ADR 0019): a write through `>`, `>>`, `tee` or a heredoc into a file there counts like a
 * `write` / `edit` call. Files outside the session folder (temp files, logs elsewhere) don't.
 * Cheap and partial on purpose: `sed -i`, `cp`, `mv`, scripts and programs that write are not
 * seen (issue #16).
 */
export interface BashWrites {
  writes: boolean;
  /** Absolute paths, when the target is known before run time. */
  paths: string[];
}

const NONE: BashWrites = { writes: false, paths: [] };

/**
 * Drops heredoc bodies and their `<<WORD` operators (`<<-`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`),
 * which the safety parser refuses. One left-to-right scan, so a quoted `<<` is left alone.
 */
function stripHeredocs(src: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  const pending: { word: string; tabs: boolean }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<" && src[i - 1] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][\w-]*))/.exec(src.slice(i));
      if (m) {
        pending.push({ word: m[2] ?? m[3] ?? m[4] ?? "", tabs: m[1] === "-" });
        out += " ";
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n" && pending.length > 0) {
      out += c;
      i++;
      for (const d of pending.splice(0)) {
        while (i < src.length) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end + 1;
          if ((d.tabs ? line.replace(/^\t+/, "") : line) === d.word) break;
        }
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The text outside quotes, in one left-to-right scan (an unclosed quote runs to the end). */
function bareText(src: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quote === null && c === "\\") i++;
    else if (quote === '"' && c === "\\") i++;
    else if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (c === quote) quote = null;
    else if (quote === null) out += c;
  }
  return out;
}

/** `$((...))`, `((...))` and `[[ ... ]]` compare with `>`; none of them redirects. */
function dropArithmetic(src: string): string {
  return src
    .replace(/\$\(\((?:[^()]|\([^()]*\))*\)\)/g, "0")
    .replace(/\(\((?:[^()]|\([^()]*\))*\)\)/g, "true")
    .replace(/\[\[[\s\S]*?\]\]/g, "true");
}

/** The real path of `p`, or of its nearest existing parent with the rest appended. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), basename(p));
  }
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export function bashWrites(command: string, cwd: string, home = homedir()): BashWrites {
  const text = dropArithmetic(stripHeredocs(command));
  const parsed = parseCommand(text);
  if (!parsed.ok) {
    // Fail toward "it wrote": any `>` outside quotes that is not `/dev/...` or a descriptor copy.
    const bare = bareText(text).replace(/[0-9&]*>>?\s*\/dev\/\S+/g, "");
    return /(^|[^>&<])>>?(?![&(])/.test(bare) ? { writes: true, paths: [] } : NONE;
  }
  const root = realish(cwd);
  const temp = realish(tmpdir());
  const counts = (abs: string) => {
    const real = realish(abs);
    if (!within(real, root)) return false;
    return !(within(real, temp) && !within(root, temp));
  };
  const expand = (p: string) => {
    if (p === "~" || p === "$HOME") return home;
    if (p.startsWith("~/")) return home + p.slice(1);
    if (p.startsWith("$HOME/")) return home + p.slice(5);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's literal ${HOME}.
    if (p.startsWith("${HOME}/") || p === "${HOME}") return home + p.slice(7);
    return p;
  };
  // A cd inside `( ... )` ends with it, and the parser flattens subshells: after a cd in a
  // command with one, the folder is unknown.
  const subshell = /(^|[^$<>])\(/.test(bareText(text));

  /** The folder later relative paths resolve against; null when it is unknown. */
  let dir: string | null = cwd;
  let writes = false;
  const paths: string[] = [];
  const add = (target: string) => {
    if (target.startsWith("/dev/")) return;
    const t = expand(target);
    if (t.includes("$") || (!isAbsolute(t) && dir === null)) {
      writes = true;
      return;
    }
    const abs = resolve(dir ?? cwd, t);
    if (!counts(abs)) return;
    writes = true;
    paths.push(abs);
  };
  for (const seg of parsed.segments) {
    const [head, ...rest] = seg.words;
    if (head === "cd") {
      const t = expand(rest[0] ?? "~");
      if (subshell || t.includes("$") || t === "-") dir = null;
      else if (isAbsolute(t)) dir = t;
      else if (dir !== null) dir = resolve(dir, t);
    }
    for (const r of seg.redirects) if (r.op !== "<") add(r.target);
    if (head === "tee") for (const w of rest) if (!w.startsWith("-")) add(w);
  }
  return writes ? { writes, paths } : NONE;
}

/** Commands that only read: the default safety rules' read-only list, plus `find`. */
const READ_ONLY_HEADS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "pwd",
  "echo",
  "which",
  "stat",
  "tree",
  "find",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show"]);
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;

/** A flag that makes an otherwise read-only command write or run something. */
function writingFlag(head: string, args: string[]): boolean {
  switch (head) {
    case "git":
      return args.some((a) => a.startsWith("--output"));
    case "rg":
      return args.some((a) => a.startsWith("--pre"));
    case "tree":
      return args.some((a) => a.startsWith("-o"));
    case "find":
      return args.some((a) => FIND_ACTIONS.test(a));
    default:
      return false;
  }
}

/** A redirect that can't write a file: input, `/dev/...`, or a descriptor copy (`2>&1`). */
const harmless = (r: { op: string; target: string }) =>
  r.op === "<" || r.target.startsWith("/dev/") || r.target.startsWith("&");

/**
 * True only for a bash command known to change nothing: every command in it is on the
 * read-only list, with no writing flag, no redirect into a file and nothing decided at run
 * time. Unparseable input, heredocs and anything not listed (`python -c`, `sed -i`, scripts)
 * are not read-only. An allowlist, so a task is never dropped for work this can't see (ADR 0012).
 */
export function bashReadOnly(command: string): boolean {
  if (!command.trim()) return false;
  const parsed = parseCommand(command);
  if (!parsed.ok) return false;
  return parsed.segments.every((seg) => {
    const [head, ...args] = seg.words;
    if (!head || seg.dynamic || !seg.redirects.every(harmless)) return false;
    if (head === "git") return READ_ONLY_GIT.has(args[0] ?? "") && !writingFlag(head, args);
    return READ_ONLY_HEADS.has(head) && !writingFlag(head, args);
  });
}
