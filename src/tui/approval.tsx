import { useKeyboard } from "@opentui/solid";
import { Show } from "solid-js";
import type { ApprovalDecision, PendingApproval } from "../events/types.ts";
import { argSummary } from "./chat-state.ts";

const COLORS = { warn: "#e0af68", muted: "#737aa2", text: "#c0caf5", danger: "#f7768e" };

/** The call's main argument is shown whole up to this many characters (a few wrapped rows). */
const APPROVAL_ARG_MAX = 600;

export interface ApprovalPromptProps {
  approval: PendingApproval;
  /** How many approvals are waiting, this one included. */
  queued: number;
  onAnswer: (decision: ApprovalDecision) => void;
}

/**
 * The inline approval for a tool call the safety layer asked about. While it shows, it owns the
 * keyboard (the input box loses focus): y allows once, a allows always (when the daemon offers a
 * pattern), n or Esc denies.
 */
export function ApprovalPrompt(props: ApprovalPromptProps) {
  const always = () => props.approval.suggestions;
  let answered = "";

  useKeyboard((key) => {
    // One answer per approval; the next one arrives with a new id.
    if (answered === props.approval.id) return;
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
  const patterns = () =>
    always()
      .map((s) => `${s.tool} "${s.pattern}"`)
      .join(", ");

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
      {/* Each part on its own rows, wrapped: the box grows to fit, so none draws over another. */}
      <text fg={COLORS.text} flexShrink={0} wrapMode="char">
        {`${props.approval.tool} ${argSummary(props.approval.args, APPROVAL_ARG_MAX)}`}
      </text>
      <text fg={COLORS.muted} flexShrink={0} wrapMode="word">
        {props.approval.reason}
      </text>
      <box flexDirection="row" flexShrink={0}>
        <text fg={COLORS.warn}>[y] allow once </text>
        <Show when={always().length > 0}>
          <text fg={COLORS.warn}> [a] always allow {patterns()} </text>
        </Show>
        <text fg={COLORS.warn}> [n] deny</text>
      </box>
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
