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
 * Rows `text` takes in a box `width` columns wide, wrapped at spaces (a longer word breaks
 * inside it). The input box grows by this: the textarea only counts its wrapped rows after it
 * has drawn them.
 */
export function wrappedRows(text: string, width: number): number {
  const w = Math.max(1, width);
  let rows = 0;
  for (const line of text.split("\n")) {
    let used = 0;
    let lineRows = 1;
    for (const word of line.split(" ")) {
      const need = used === 0 ? word.length : used + 1 + word.length;
      if (need <= w) {
        used = need;
        continue;
      }
      if (used > 0) lineRows++;
      // The word on fresh rows, broken where it is longer than one.
      lineRows += Math.max(0, Math.ceil(word.length / w) - 1);
      used = word.length % w || w;
    }
    rows += lineRows;
  }
  return Math.max(1, rows);
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
