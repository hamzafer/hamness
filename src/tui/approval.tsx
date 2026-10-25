import { useKeyboard } from "@opentui/solid";
import { createEffect, on } from "solid-js";
import type { ApprovalDecision, PendingApproval } from "../events/types.ts";
import { argSummary } from "./chat-state.ts";
import { wrappedRows } from "./layout.ts";

const COLORS = { warn: "#e0af68", muted: "#737aa2", text: "#c0caf5", danger: "#f7768e" };

/** The call's main argument is read up to this many characters before it is clamped to rows. */
const APPROVAL_ARG_MAX = 2000;
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

/**
 * How the box's rows are shared: the call and the reason each get what they need, clamped so
 * the whole box (border and the one-row choices included) stays within `maxHeight`.
 */
export function approvalLayout(
  call: string,
  reason: string,
  width: number,
  maxHeight: number,
): { call: string; callRows: number; reason: string; reasonRows: number } {
  const inner = Math.max(10, width - 4);
  // Border (2) and the choices (1).
  const room = Math.max(2, maxHeight - 3);
  const callNeed = Math.max(1, Math.ceil(call.length / inner));
  const reasonNeed = reason ? wrappedRows(reason.replace(/\s+/g, " ").trim(), inner) : 0;
  // The reason keeps at least a row (when there is one); the call gets the rest it needs.
  const reasonMin = Math.min(reasonNeed, Math.max(1, Math.floor(room / 3)));
  const callRows = Math.max(1, Math.min(callNeed, room - reasonMin));
  const reasonRows = Math.min(reasonNeed, room - callRows);
  return {
    call: clampChars(call, inner, callRows),
    callRows,
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

/**
 * The inline approval for a tool call the safety layer asked about. While it shows, it owns the
 * keyboard (the input box loses focus): y allows once, a allows always (when the daemon offers a
 * pattern), n or Esc denies. Keys in its first `armMs` are ignored.
 */
export function ApprovalPrompt(props: ApprovalPromptProps) {
  const always = () => props.approval.suggestions;
  let answered = "";
  let shownAt = Date.now();
  createEffect(
    on(
      () => props.approval.id,
      () => {
        shownAt = Date.now();
      },
    ),
  );

  useKeyboard((key) => {
    // One answer per approval; the next one arrives with a new id.
    if (answered === props.approval.id) return;
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
  const layout = () =>
    approvalLayout(
      `${props.approval.tool} ${argSummary(props.approval.args, APPROVAL_ARG_MAX)}`,
      props.approval.reason,
      props.width,
      props.maxHeight,
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
      <text fg={COLORS.text} flexShrink={0} height={layout().callRows} wrapMode="char">
        {layout().call}
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

/** Shown on every screen while the session runs in yolo mode. */
export function YoloBanner() {
  return (
    <box height={1} flexShrink={0} backgroundColor={COLORS.danger}>
      <text fg="#000000">
        {" YOLO MODE  Every tool call runs without a check. Type /mode auto to leave. "}
      </text>
    </box>
  );
}
