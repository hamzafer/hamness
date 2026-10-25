import type { SessionStatus } from "../agent/session-hub.ts";
import { oneLine } from "./commands.ts";
import { plural, shortPath } from "./layout.ts";
import { PICKER_COLORS } from "./picker.tsx";
import { formatCost, formatTokens } from "./rail-state.ts";

/** `/status`'s rows: label and value, in the order a glance wants them. */
export function statusRows(s: SessionStatus, home: string): Array<readonly [string, string]> {
  const ctx = s.context;
  const context = !ctx
    ? "not measured yet"
    : ctx.tokens === null
      ? `just compacted · ${formatTokens(ctx.contextWindow)} window`
      : `${formatTokens(ctx.tokens)} of ${formatTokens(ctx.contextWindow)} (${Math.round(ctx.percent ?? 0)}%)`;
  const t = s.tokens;
  const cache = t.cacheRead + t.cacheWrite;
  const tokens = `${formatTokens(t.total)} · ${formatTokens(t.input)} in, ${formatTokens(t.output)} out${cache ? `, ${formatTokens(cache)} cache` : ""}`;
  const task = s.task
    ? `${oneLine(s.task.goal, 44)} · ${s.task.outcome}${s.task.evidence ? ` · ${s.task.passed}/${plural(s.task.evidence, "check")}` : ""}`
    : "none";
  const rows: Array<readonly [string, string]> = [];
  if (s.name) rows.push(["Session", s.name]);
  rows.push(
    ["Model", s.model],
    ["Thinking", s.thinkingLevel],
    ["Context", context],
    ["Tokens", tokens],
    ["Cost", formatCost(s.costMicros)],
    [
      "Messages",
      [
        plural(s.messages.user, "prompt"),
        plural(s.messages.assistant, "reply", "replies"),
        plural(s.messages.toolCalls, "tool call"),
      ].join(", "),
    ],
    ["Task", task],
  );
  if (s.mode) rows.push(["Mode", s.modeSource === "session" ? `${s.mode} (this session)` : s.mode]);
  if (s.judge) rows.push(["Judge", s.judge]);
  rows.push(["Branch", s.branch ?? "not a git repo"], ["Folder", shortPath(s.cwd, home, 60)]);
  return rows;
}

/** `/status` (and `/cost`): a compact panel above the input box. Esc closes it. */
export function StatusPanel(props: { status: SessionStatus; home: string }) {
  const rows = () => statusRows(props.status, props.home);
  const width = () => Math.max(...rows().map(([k]) => k.length)) + 3;
  return (
    <box
      border
      borderColor={PICKER_COLORS.dim}
      title=" Status "
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      {rows().map(([k, v]) => (
        <box flexDirection="row" height={1}>
          <text flexShrink={0} fg={PICKER_COLORS.muted}>
            {k.padEnd(width())}
          </text>
          <text fg={k === "Mode" && v.startsWith("yolo") ? "#f7768e" : PICKER_COLORS.text}>
            {v}
          </text>
        </box>
      ))}
      <text fg={PICKER_COLORS.dim}>Esc closes</text>
    </box>
  );
}
