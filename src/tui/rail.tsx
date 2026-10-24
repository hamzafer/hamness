import { For, Show } from "solid-js";
import type { ContextFill } from "../events/types.ts";
import {
  elapsedMs,
  formatCost,
  formatElapsed,
  formatTokens,
  RAIL_GLYPH,
  type RailAgent,
  type RailState,
  type RailTask,
  sessionCostMicros,
} from "./rail-state.ts";

/** Calm on purpose: plain text, muted labels, red only for errors. */
const COLORS = {
  text: "#c0caf5",
  muted: "#737aa2",
  error: "#f7768e",
};

/** Width of the rail beside the chat, border included. */
export const RAIL_WIDTH = 32;
const GAUGE_CELLS = 10;

export interface RailProps {
  state: RailState;
  /** Clock for elapsed times (ms); the app ticks it once a second. */
  now: number;
  /** The current task. Ticket #6 feeds it; until then the slot shows a placeholder. */
  task?: RailTask;
  /** Full screen: the rail takes the whole terminal and rows get one wide line each. */
  full?: boolean;
  /** Text width inside the rail. */
  width?: number;
}

function clip(s: string, width: number): string {
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}

/** `left` and `right` on one line, `right` flush with the edge. */
function spread(left: string, right: string, width: number): string {
  const room = width - right.length - 1;
  const l = clip(left, Math.max(1, room));
  return `${l}${" ".repeat(Math.max(1, width - l.length - right.length))}${right}`;
}

export function gauge(fill: ContextFill | undefined): string {
  if (!fill || fill.percent === null) return "?";
  const pct = Math.min(100, Math.max(0, fill.percent));
  const on = Math.round((pct / 100) * GAUGE_CELLS);
  return `${"▰".repeat(on)}${"▱".repeat(GAUGE_CELLS - on)}  ${Math.round(pct)}%`;
}

export function Rail(props: RailProps) {
  const width = () => props.width ?? RAIL_WIDTH - 4;
  const ctx = () => props.state.context;
  return (
    <box
      flexDirection="column"
      border
      borderColor={COLORS.muted}
      title={props.full ? "side rail · Ctrl+R back" : "side rail · Ctrl+R full"}
      paddingLeft={1}
      paddingRight={1}
      {...(props.full ? { flexGrow: 1 } : { width: RAIL_WIDTH })}
      minHeight={0}
    >
      <Label name="task" value={props.task ? taskLine(props.task) : "none yet"} width={width()} />
      <Label name="ctx" value={gauge(ctx())} width={width()} />
      <Show when={ctx()?.tokens != null}>
        <text fg={COLORS.muted}>
          {`      ${formatTokens(ctx()?.tokens ?? 0)} / ${formatTokens(ctx()?.contextWindow ?? 0)}`}
        </text>
      </Show>
      <Label name="cost" value={formatCost(sessionCostMicros(props.state))} width={width()} />
      <For each={props.state.agents}>
        {(agent) => (
          <AgentRow agent={agent} now={props.now} width={width()} full={props.full ?? false} />
        )}
      </For>
    </box>
  );
}

function taskLine(task: RailTask): string {
  return `${task.goal} (${task.outcome}, ${task.evidence} proof)`;
}

function Label(props: { name: string; value: string; width: number }) {
  return (
    <box flexDirection="row" height={1}>
      <text fg={COLORS.muted}>{props.name.padEnd(6)}</text>
      <text fg={COLORS.text}>{clip(props.value, props.width - 6)}</text>
    </box>
  );
}

function AgentRow(props: { agent: RailAgent; now: number; width: number; full: boolean }) {
  const a = () => props.agent;
  const failed = () => a().status === "error";
  const elapsed = () => {
    const ms = elapsedMs(a(), props.now);
    return ms === undefined ? "" : formatElapsed(ms);
  };
  const head = () => `${RAIL_GLYPH[a().status]} ${a().name}`;
  const tool = () => (a().tool ? `${a().tool}${a().file ? `  ${a().file}` : ""}` : "");
  const totals = () => `${formatTokens(a().tokens)} tok  ${formatCost(a().costMicros)}`;
  return (
    <box flexDirection="column" paddingTop={1}>
      <Show
        when={props.full}
        fallback={
          <>
            <text fg={failed() ? COLORS.error : COLORS.text}>
              {spread(head(), elapsed(), props.width)}
            </text>
            <Show when={tool()}>
              <text fg={a().toolRunning ? COLORS.text : COLORS.muted}>
                {clip(`  ${tool()}`, props.width)}
              </text>
            </Show>
            <text fg={COLORS.muted}>{clip(`  ${totals()}`, props.width)}</text>
          </>
        }
      >
        <text fg={failed() ? COLORS.error : COLORS.text}>
          {clip(
            [head().padEnd(16), tool().padEnd(36), elapsed().padStart(7), `  ${totals()}`].join(
              "  ",
            ),
            props.width,
          )}
        </text>
      </Show>
      <Show when={a().error}>
        <text fg={COLORS.error}>
          {props.full ? `  ${a().error}` : clip(`  ${a().error}`, props.width)}
        </text>
      </Show>
    </box>
  );
}
