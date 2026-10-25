import { useKeyboard } from "@opentui/solid";
import { createEffect, createSignal, on } from "solid-js";
import type { ApprovalDecision, PendingApproval } from "../events/types.ts";
import { argSummary } from "./chat-state.ts";
import { wrappedRows } from "./layout.ts";

const COLORS = { warn: "#e0af68", muted: "#737aa2", text: "#c0caf5", danger: "#f7768e" };

/**
 * The call's main argument is read up to this many characters. The box scrolls through it, so
 * the user can read all of it before answering.
 */
const APPROVAL_ARG_MAX = 20_000;
/** A backticked span in the reason longer than this is cut (the call itself shows above it). */
const REASON_SPAN_MAX = 48;
/** The `[a]` choice's pattern text, at most. */
const PATTERNS_MAX = 40;
/** Keys are ignored this long after an approval shows, so typing ahead never answers it. */
export const APPROVAL_ARM_MS = 400;

export interface ApprovalPromptProps {
  approval: PendingApproval;
  /** How many approvals are waiting, this one included. */
  queued: number;
  onAnswer: (decision: ApprovalDecision) => void;
  /** Columns the box may take, border included. */
  width: number;
  /** Rows the box may take at most, border included (the app gives it half the terminal). */
  maxHeight: number;
  /** How long keys are ignored after an approval shows. Default `APPROVAL_ARM_MS`. */
  armMs?: number;
}

/** `text` cut to the first `rows` rows of a char-wrapped box `width` wide, `…` at the cut. */
export function clampChars(text: string, width: number, rows: number): string {
  const max = Math.max(1, width * rows);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `text` cut to whole words that fit `rows` rows of a word-wrapped box `width` wide. */
export function clampWords(text: string, width: number, rows: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (wrappedRows(flat, width) <= rows) return flat;
  const words = flat.split(" ");
  let lo = 0;
  let hi = words.length;
  // The most words that fit with the `…`.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (wrappedRows(`${words.slice(0, mid).join(" ")}…`, width) <= rows) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${words.slice(0, lo).join(" ")}…` : clampChars(flat, width, rows);
}

/** `text` in rows of `width` columns, broken anywhere (wide characters count two). */
export function charRows(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const ch of text) {
    const cols = Bun.stringWidth(ch);
    if (used + cols > w && row) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += ch;
    used += cols;
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

/**
 * The reason without the call again: a rule's ``for `<the whole command>` `` is dropped (the
 * command shows above it), and any other long backticked span is cut short.
 */
export function reasonWithoutCall(reason: string, command: string): string {
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  const cmd = flat(command);
  return reason
    .replace(/\s+for `([^`]*)`/g, (whole, span: string) => (cmd && flat(span) === cmd ? "" : whole))
    .replace(/`([^`]*)`/g, (whole, span: string) =>
      span.length > REASON_SPAN_MAX ? `\`${span.slice(0, REASON_SPAN_MAX - 1)}…\`` : whole,
    );
}

export interface ApprovalLayout {
  /** The call's rows that show now, one per line. */
  call: string;
  callRows: number;
  /** How many rows the whole call takes, and the first one shown. */
  total: number;
  offset: number;
  /** The scroll hint's row when the call doesn't fit, else empty. */
  more: string;
  reason: string;
  reasonRows: number;
}

/**
 * How the box's rows are shared: the call and the reason each get what they need, clamped so
 * the whole box (border and the one-row choices included) stays within `maxHeight`. A call
 * longer than its rows shows a window of them from `offset`, over a scroll hint.
 */
export function approvalLayout(
  call: string,
  reason: string,
  width: number,
  maxHeight: number,
  offset = 0,
): ApprovalLayout {
  const inner = Math.max(10, width - 4);
  // Border (2) and the choices (1).
  const room = Math.max(2, maxHeight - 3);
  const lines = charRows(call, inner);
  const callNeed = lines.length;
  const reasonNeed = reason ? wrappedRows(reason.replace(/\s+/g, " ").trim(), inner) : 0;
  // The reason keeps at least a row (when there is one); the call gets the rest it needs.
  const reasonMin = Math.min(reasonNeed, Math.max(1, Math.floor(room / 3)));
  const callRows = Math.max(1, Math.min(callNeed, room - reasonMin));
  const reasonRows = Math.min(reasonNeed, room - callRows);
  const clipped = callNeed > callRows;
  // Clipped: one of the call's rows holds the scroll hint.
  const shown = clipped ? Math.max(1, callRows - 1) : callRows;
  const from = Math.min(Math.max(0, offset), Math.max(0, callNeed - shown));
  const below = callNeed - from - shown;
  const more = !clipped
    ? ""
    : below > 0
      ? `(+${below} more ${below === 1 ? "line" : "lines"}, ↑↓ to scroll)`
      : `(${from} ${from === 1 ? "line" : "lines"} above, ↑ to scroll back)`;
  return {
    call: lines.slice(from, from + shown).join("\n"),
    callRows: shown,
    total: callNeed,
    offset: from,
    more,
    reason: reasonRows > 0 ? clampWords(reason, inner, reasonRows) : "",
    reasonRows,
  };
}

/** The choices on one row of `inner` columns: `[n] deny` always shows. */
export function choiceRow(suggestions: PendingApproval["suggestions"], inner: number): string {
  const all = suggestions.map((s) => `${s.tool} "${s.pattern}"`).join(", ");
  const fit = (once: string, always: string) => {
    if (!suggestions.length) return `${once}  [n] deny`;
    const fixed = `${once}  ${always}   [n] deny`.length;
    const room = Math.min(PATTERNS_MAX, inner - fixed);
    if (room < 4) return undefined;
    const pattern = all.length > room ? `${all.slice(0, room - 1)}…` : all;
    return `${once}  ${always} ${pattern}  [n] deny`;
  };
  return (
    fit("[y] allow once", "[a] always allow") ??
    fit("[y] once", "[a] always") ??
    "[y] once  [a] always  [n] deny"
  );
}

/** Keys that scroll a long call, and by how many rows (`page`: the rows it shows). */
function scrollBy(name: string, page: number): number | undefined {
  switch (name) {
    case "up":
      return -1;
    case "down":
      return 1;
    case "pageup":
      return -page;
    case "pagedown":
      return page;
    case "home":
      return Number.NEGATIVE_INFINITY;
    case "end":
      return Number.POSITIVE_INFINITY;
    default:
      return undefined;
  }
}

/**
 * The inline approval for a tool call the safety layer asked about. While it shows, it owns the
 * keyboard (the input box loses focus): y allows once, a allows always (when the daemon offers a
 * pattern), n or Esc denies. Keys in its first `armMs` are ignored. A call too long for the box
 * scrolls with Up/Down, PgUp/PgDn and Home/End, so all of it can be read before answering.
 */
export function ApprovalPrompt(props: ApprovalPromptProps) {
  const always = () => props.approval.suggestions;
  let answered = "";
  let shownAt = Date.now();
  const [offset, setOffset] = createSignal(0);
  createEffect(
    on(
      () => props.approval.id,
      () => {
        shownAt = Date.now();
        setOffset(0);
      },
    ),
  );

  useKeyboard((key) => {
    // One answer per approval; the next one arrives with a new id.
    if (answered === props.approval.id) return;
    // Scrolling never answers, so it needs no arming.
    const by = scrollBy(key.name, layout().callRows);
    if (by !== undefined) {
      key.preventDefault();
      const l = layout();
      const last = Math.max(0, l.total - l.callRows);
      setOffset(Math.min(last, Math.max(0, l.offset + by)));
      return;
    }
    if (Date.now() - shownAt < (props.armMs ?? APPROVAL_ARM_MS)) return;
    let decision: ApprovalDecision | undefined;
    if (key.name === "y") decision = "allow-once";
    else if (key.name === "a" && always().length > 0) decision = "allow-always";
    else if (key.name === "n" || key.name === "escape") decision = "deny";
    if (!decision) return;
    answered = props.approval.id;
    props.onAnswer(decision);
  });

  const title = () => {
    const from = props.approval.agentName ? ` from subagent ${props.approval.agentName}` : "";
    const of = props.queued > 1 ? ` (1 of ${props.queued})` : "";
    return `approve this tool call${from}?${of}`;
  };
  /** One row: the long words when they fit, else short ones; the pattern gets what is left. */
  const choices = () => choiceRow(always(), props.width - 4);
  const command = () => argSummary(props.approval.args, APPROVAL_ARG_MAX);
  const layout = () =>
    approvalLayout(
      `${props.approval.tool} ${command()}`,
      reasonWithoutCall(props.approval.reason, command()),
      props.width,
      props.maxHeight,
      offset(),
    );

  return (
    <box
      border
      borderColor={COLORS.warn}
      title={title()}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Each part on its own rows, clamped to them: none draws over another, and the box
          never pushes the choices or the input box off screen. */}
      <text fg={COLORS.text} flexShrink={0} height={layout().callRows} wrapMode="none">
        {layout().call}
      </text>
      <text
        fg={COLORS.muted}
        flexShrink={0}
        height={1}
        visible={layout().more !== ""}
        wrapMode="none"
      >
        {layout().more}
      </text>
      <text
        fg={COLORS.muted}
        flexShrink={0}
        height={layout().reasonRows}
        visible={layout().reasonRows > 0}
        wrapMode="word"
      >
        {layout().reason}
      </text>
      <text fg={COLORS.warn} flexShrink={0} height={1} wrapMode="none">
        {choices()}
      </text>
    </box>
  );
}

/**
 * The banner's words when no `safety.mode` warning came (an attach to a yolo session): the
 * daemon's own (`YOLO_WARNING`, ADR 0022), which says deny rules still apply.
 */
export const YOLO_FALLBACK =
  "yolo mode: tool calls run with no question or judge. Deny rules still block direct references to secrets, and a call hamness cannot see past (a recursive search over secrets, a heredoc, a path in a variable) still asks; yolo cannot see inside scripts and interpreters. Switch back with /mode auto.";

/** The banner's text: a loud label, then the warning without its own `yolo mode:` lead. */
export function yoloBannerText(warning: string | undefined): string {
  const body = (warning?.trim() || YOLO_FALLBACK).replace(/^yolo mode:\s*/i, "");
  return ` YOLO MODE  ${body.charAt(0).toUpperCase()}${body.slice(1)} `;
}

/** Shown on every screen while the session runs in yolo mode, on as many rows as it needs. */
export function YoloBanner(props: { warning?: string | undefined }) {
  return (
    <box flexShrink={0} backgroundColor={COLORS.danger}>
      <text fg="#000000" wrapMode="word">
        {yoloBannerText(props.warning)}
      </text>
    </box>
  );
}
