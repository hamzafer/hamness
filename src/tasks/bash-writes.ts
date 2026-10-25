import { resolve } from "node:path";
import { parseCommand } from "../safety/shell.ts";

/**
 * Whether a bash command writes files, and which, for the proof rules (ADR 0019): a write
 * through `>`, `>>`, `tee` or a heredoc into a file counts like a `write` / `edit` call.
 * Cheap and partial on purpose: `sed -i`, `cp`, `mv`, scripts and programs that write are not
 * seen (issue #16).
 */
export interface BashWrites {
  writes: boolean;
  /** Absolute paths, when the target is known before run time. */
  paths: string[];
}

const NONE: BashWrites = { writes: false, paths: [] };

/** Drops heredoc bodies and their `<<WORD` operators, which the safety parser refuses. */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const delimiters: { word: string; tabs: boolean }[] = [];
    const line = (lines[i] as string).replace(
      /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2/g,
      (_m, dash: string, _q: string, word: string) => {
        delimiters.push({ word, tabs: dash === "-" });
        return " ";
      },
    );
    out.push(line);
    for (const d of delimiters) {
      while (++i < lines.length) {
        const body = lines[i] as string;
        if ((d.tabs ? body.replace(/^\t+/, "") : body) === d.word) break;
      }
    }
  }
  return out.join("\n");
}

const writesTo = (target: string) => !target.startsWith("/dev/");
const runtime = (word: string) => word.includes("$");

export function bashWrites(command: string, cwd: string): BashWrites {
  const text = stripHeredocs(command);
  const parsed = parseCommand(text);
  if (!parsed.ok) {
    // Fail toward "it wrote": any `>` outside quotes that is not a descriptor copy.
    const bare = text.replace(/'[^']*('|$)/g, "").replace(/"(\\.|[^"\\])*("|$)/g, "");
    return /(^|[^>&<])>>?(?![&(])/.test(bare) ? { writes: true, paths: [] } : NONE;
  }
  let dir = cwd;
  let writes = false;
  const paths: string[] = [];
  const add = (target: string) => {
    if (!writesTo(target)) return;
    writes = true;
    if (!runtime(target)) paths.push(resolve(dir, target));
  };
  for (const seg of parsed.segments) {
    const [head, ...rest] = seg.words;
    if (head === "cd" && rest[0] && !runtime(rest[0])) dir = resolve(dir, rest[0]);
    for (const r of seg.redirects) if (r.op !== "<") add(r.target);
    if (head === "tee") for (const w of rest) if (!w.startsWith("-")) add(w);
  }
  return writes ? { writes, paths } : NONE;
}
