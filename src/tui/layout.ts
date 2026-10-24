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
