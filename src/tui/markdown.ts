import { type NativeResourceOwner, SyntaxStyle } from "@opentui/core";

/**
 * How assistant Markdown looks, by the scopes OpenTUI's `<markdown>` renders (ADR 0010).
 * Same palette as the chat: headings and links in blue, code green, markers muted.
 */
const HEADING = { fg: "#7aa2f7", bold: true };

export const MARKDOWN_STYLES = {
  default: { fg: "#c0caf5" },
  conceal: { fg: "#737aa2" },
  "markup.heading": HEADING,
  // Headings arrive as markup.heading.1 to .6, and OpenTUI falls back only to `markup`.
  "markup.heading.1": HEADING,
  "markup.heading.2": HEADING,
  "markup.heading.3": HEADING,
  "markup.heading.4": HEADING,
  "markup.heading.5": HEADING,
  "markup.heading.6": HEADING,
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": { fg: "#9ece6a" },
  "markup.raw.block": { fg: "#9ece6a" },
  "markup.list": { fg: "#e0af68" },
  "markup.quote": { fg: "#737aa2", italic: true },
  "markup.link": { fg: "#7dcfff" },
  "markup.link.label": { fg: "#7dcfff", underline: true },
  "markup.link.url": { fg: "#737aa2" },
};

/** The style `<markdown>` needs, owned by the renderer's scene; destroy it with the view. */
export function markdownStyle(owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromStyles(MARKDOWN_STYLES, owner);
}
