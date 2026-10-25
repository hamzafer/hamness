/** Fitting the chat pane's one-line texts (the header path, the input hint) to its width. */

/**
 * `path` in at most `max` columns: the home folder as `~`, then the middle elided (`~/…/b/c`)
 * folder by folder. The last folder name always stays whole, even when it alone is too long.
 */
export function shortPath(path: string, home: string, max: number): string {
  const underHome = home.length > 1 && (path === home || path.startsWith(`${home}/`));
  const shown = underHome ? `~${path.slice(home.length)}` : path;
  if (shown.length <= max) return shown;

  const parts = shown.split("/");
  const last = parts.at(-1) ?? shown;
  // The head is `~`, or `/` and the first folder of an absolute path.
  const headCount = parts[0] === "" ? 2 : 1;
  const head = parts.slice(0, headCount).join("/");
  if (parts.length > headCount + 1) {
    let tail = last;
    if (`${head}/…/${tail}`.length <= max) {
      for (let i = parts.length - 2; i >= headCount; i--) {
        const longer = `${parts[i]}/${tail}`;
        if (`${head}/…/${longer}`.length > max) break;
        tail = longer;
      }
      return `${head}/…/${tail}`;
    }
  }
  return `…/${last}`.length <= max ? `…/${last}` : last;
}

/**
 * Rows `text` takes in a box `width` columns wide (wide characters count two), wrapped at
 * spaces (a longer word breaks inside it). The input box grows by this: the textarea only
 * counts its wrapped rows after it has drawn them.
 */
export function wrappedRows(text: string, width: number): number {
  const w = Math.max(1, width);
  let rows = 0;
  for (const line of text.split("\n")) {
    let used = 0;
    let lineRows = 1;
    for (const word of line.split(" ")) {
      const cols = Bun.stringWidth(word);
      const need = used === 0 ? cols : used + 1 + cols;
      if (need <= w) {
        used = need;
        continue;
      }
      if (used > 0) lineRows++;
      // The word on fresh rows, broken where it is longer than one.
      lineRows += Math.max(0, Math.ceil(cols / w) - 1);
      used = cols % w || w;
    }
    rows += lineRows;
  }
  return Math.max(1, rows);
}

/** What the chat's header row says, before it is fit to the pane. */
export interface HeaderInput {
  name?: string | undefined;
  cwd: string;
  home: string;
  /** `provider/id`. */
  model: string;
  /** `plan`, `API`, ...: shown after the model. */
  billing?: string | undefined;
  judge?: { text: string; warn: boolean } | undefined;
  busy: boolean;
}

/** One part of the header row, with the separator before it included. */
export interface HeaderPart {
  text: string;
  tone: "muted" | "name" | "warn";
}

const HEADER_SEP = " · ";
/** Shorter than this, the folder isn't worth showing. */
const HEADER_PATH_MIN = 8;
/** A long session name is cut to this before the model gives anything up. */
const HEADER_NAME_SHORT = 16;

const cut = (text: string, max: number) =>
  text.length <= max ? text : max <= 1 ? "…" : `${text.slice(0, max - 1)}…`;

/**
 * The header row (`hamness · name · folder · model · plan · judge on · working…`) fit to
 * `width` columns, each part whole or cleanly cut, so none ever draws over another. Short of
 * room the parts give way in order: the folder shrinks then goes, then the judge, the name is
 * cut, the billing word goes, then the model's provider, then the name, then `working…` (the
 * rail shows the run too); last the model is cut. `hamness` always stays.
 */
export function headerParts(h: HeaderInput, width: number): HeaderPart[] {
  const bare = h.model.includes("/") ? h.model.slice(h.model.indexOf("/") + 1) : h.model;
  type Shape = { name?: string; path: boolean; judge: boolean; model: string; busy?: false };
  const full = h.billing ? `${h.model}${HEADER_SEP}${h.billing}` : h.model;
  const name = h.name;
  const short = name ? cut(name, HEADER_NAME_SHORT) : undefined;
  const shapes: Shape[] = [
    { ...(name ? { name } : {}), path: true, judge: true, model: full },
    { ...(name ? { name } : {}), path: false, judge: true, model: full },
    { ...(name ? { name } : {}), path: false, judge: false, model: full },
    { ...(short ? { name: short } : {}), path: false, judge: false, model: full },
    { ...(short ? { name: short } : {}), path: false, judge: false, model: h.model },
    { ...(short ? { name: short } : {}), path: false, judge: false, model: bare },
    { path: false, judge: false, model: bare },
    { path: false, judge: false, model: bare, busy: false },
  ];
  const build = (s: Shape, model: string, path?: string): HeaderPart[] => {
    const parts: HeaderPart[] = [{ text: "hamness", tone: "muted" }];
    if (s.name) parts.push({ text: `${HEADER_SEP}${s.name}`, tone: "name" });
    if (path) parts.push({ text: `${HEADER_SEP}${path}`, tone: "muted" });
    parts.push({ text: `${HEADER_SEP}${model}`, tone: "muted" });
    if (s.judge && h.judge) {
      parts.push({ text: `${HEADER_SEP}${h.judge.text}`, tone: h.judge.warn ? "warn" : "muted" });
    }
    if (h.busy && s.busy !== false) parts.push({ text: `${HEADER_SEP}working…`, tone: "warn" });
    return parts;
  };
  const length = (parts: HeaderPart[]) => parts.reduce((n, p) => n + p.text.length, 0);
  for (const s of shapes) {
    const without = build(s, s.model);
    const used = length(without);
    if (used > width) continue;
    if (!s.path) return without;
    const room = width - used - HEADER_SEP.length;
    const path = room >= HEADER_PATH_MIN ? shortPath(h.cwd, h.home, room) : "";
    if (path && path.length <= room) return build(s, s.model, path);
  }
  // Even `hamness · <model>` doesn't fit: the model is cut, else `hamness` alone.
  const room = width - `hamness${HEADER_SEP}`.length;
  if (room >= 2) return [{ text: `hamness${HEADER_SEP}${cut(bare, room)}`, tone: "muted" }];
  return [{ text: cut("hamness", Math.max(1, width)), tone: "muted" }];
}

const WELCOME_HINT = "Type / for commands";

/**
 * The empty chat's one line in `width` columns: folder, model and the hint. Short of room the
 * folder goes first, then the model's provider, then the model; the hint always stays.
 */
export function welcomeLine(cwd: string, home: string, model: string, width: number): string {
  const sep = " · ";
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const room = width - model.length - WELCOME_HINT.length - 2 * sep.length;
  const folder = room >= 8 ? shortPath(cwd, home, room) : "";
  if (folder && folder.length <= room) return [folder, model, WELCOME_HINT].join(sep);
  for (const m of [model, bare]) {
    const line = `${m}${sep}${WELCOME_HINT}`;
    if (line.length <= width) return line;
  }
  return WELCOME_HINT;
}

/** `1 prompt`, `2 prompts`: the count and the word in the number it needs. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** The input box's hint, longest first. */
export const PROMPT_HINTS: readonly string[] = [
  "Ask hamness… (Enter sends, Shift+Enter or Ctrl+J new line, Esc stops, /help lists commands, Ctrl+C leaves)",
  "Ask hamness… (Enter sends, Ctrl+J new line, Esc stops, /help for more)",
  "Ask hamness… (Enter sends, /help for keys)",
  "Ask hamness… (/help)",
  "Ask hamness…",
];

/** The longest hint that fits `width` columns, so it is never cut mid-sentence. */
export function promptHint(width: number): string {
  return PROMPT_HINTS.find((h) => h.length <= width) ?? "Ask hamness…";
}
