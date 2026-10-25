import { For, Show } from "solid-js";
import type { ContextFill } from "../events/types.ts";
import { ORB_LABEL } from "../orbs/activity.ts";
import type { OrbState } from "../orbs/index.ts";
import { ORB_COLS, Orb } from "./orb.tsx";
import {
  elapsedMs,
  formatCost,
  formatElapsed,
  formatTokens,
  RAIL_CHECKS,
  RAIL_GLYPH,
  type RailAgent,
  type RailCheck,
  type RailState,
  type RailTask,
  railOrbState,
  sessionCostMicros,
} from "./rail-state.ts";

/** Calm on purpose: plain text, muted labels, red only for errors. */
const COLORS = {
  text: "#c0caf5",
  muted: "#737aa2",
  ok: "#9ece6a",
  error: "#f7768e",
};

/** How the task's outcome line is colored: unverified is red (the proof gate failed). */
export function taskTone(task: RailTask): keyof typeof COLORS {
  switch (task.outcome) {
    case "unverified":
      return "error";
    case "verified":
      return "ok";
    case "open":
      return "muted";
    default:
      return "text";
  }
}

/** Width of the rail beside the chat, border included. */
export const RAIL_WIDTH = 32;
const GAUGE_CELLS = 10;

export interface RailProps {
  state: RailState;
  /** Clock for elapsed times (ms); the app ticks it once a second. */
  now: number;
  /** Full screen: the rail takes the whole terminal and rows get one wide line each. */
  full?: boolean;
  /** Text width inside the rail. */
  width?: number;
  /** Seconds into the orbs' animation; without it running agents show a still orb. */
  orbSeconds?: number | undefined;
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
      <Label
        name={props.state.task && props.state.task.outcome !== "open" ? "last" : "task"}
        value={props.state.task?.goal ?? "none yet"}
        width={width()}
      />
      <Show when={props.state.task}>
        {(task: () => RailTask) => (
          <text fg={COLORS[taskTone(task())]}>{clip(`      ${taskStatus(task())}`, width())}</text>
        )}
      </Show>
      <Label name="ctx" value={gauge(ctx())} width={width()} />
      <Show when={ctx()?.tokens != null}>
        <text fg={COLORS.muted}>
          {`      ${formatTokens(ctx()?.tokens ?? 0)} / ${formatTokens(ctx()?.contextWindow ?? 0)}`}
        </text>
      </Show>
      <Label name="cost" value={formatCost(sessionCostMicros(props.state))} width={width()} />
      <Show when={props.full && props.state.tasks.length > 0}>
        <TaskList tasks={props.state.tasks} width={width()} />
      </Show>
      <For each={props.state.agents}>
        {(agent) => (
          <AgentRow
            agent={agent}
            orb={railOrbState(props.state, agent)}
            orbSeconds={props.orbSeconds}
            now={props.now}
            width={width()}
            full={props.full ?? false}
          />
        )}
      </For>
      <For each={props.full ? props.state.checks : props.state.checks.slice(-RAIL_CHECKS)}>
        {(check) => <CheckRow check={check} now={props.now} width={width()} />}
      </For>
    </box>
  );
}

const CHECK_GLYPH: Record<RailCheck["status"], string> = {
  running: "●",
  passed: "✓",
  failed: "✗",
  error: "✗",
};

/** A proof check (P-M3): what hamness is re-running or reading, and how it ended. */
function CheckRow(props: { check: RailCheck; now: number; width: number }) {
  const c = () => props.check;
  const bad = () => c().status === "failed" || c().status === "error";
  const elapsed = () => formatElapsed(Math.max(0, (c().endedAt ?? props.now) - c().startedAt));
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={bad() ? COLORS.error : c().status === "passed" ? COLORS.ok : COLORS.text}>
        {spread(`${CHECK_GLYPH[c().status]} check  ${c().label}`, elapsed(), props.width)}
      </text>
      <Show when={c().summary}>
        <text fg={COLORS.muted}>{clip(`  ${c().status}: ${c().summary}`, props.width)}</text>
      </Show>
    </box>
  );
}

/** Full screen: the session's tasks, one line each, with how they ended. */
function TaskList(props: { tasks: RailTask[]; width: number }) {
  const goalWidth = () => Math.max(10, Math.min(48, props.width - 32));
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={COLORS.muted}>tasks this session</text>
      <For each={props.tasks}>
        {(task) => (
          <text fg={COLORS[taskTone(task)]}>
            {clip(
              `  ${clip(task.goal, goalWidth()).padEnd(goalWidth())}  ${taskStatus(task)}`,
              props.width,
            )}
          </text>
        )}
      </For>
    </box>
  );
}

function taskStatus(task: RailTask): string {
  return `${task.outcome} · ${task.passed}/${task.evidence} proof`;
}

function Label(props: { name: string; value: string; width: number }) {
  return (
    <box flexDirection="row" height={1}>
      <text fg={COLORS.muted}>{props.name.padEnd(6)}</text>
      <text fg={COLORS.text}>{clip(props.value, props.width - 6)}</text>
    </box>
  );
}

function AgentRow(props: {
  agent: RailAgent;
  orb: OrbState | undefined;
  orbSeconds: number | undefined;
  now: number;
  width: number;
  full: boolean;
}) {
  const a = () => props.agent;
  /** Room for the text beside the orb (its cells and a space). */
  const textWidth = () => (props.orb ? props.width - ORB_COLS - 1 : props.width);
  /** Beside the orb, plain words for what it does, and the file a running tool touches. */
  const detail = () => {
    if (!props.orb) return tool();
    const label = ORB_LABEL[props.orb];
    const withFile = a().toolRunning && a().file ? `${label}  ${a().file}` : label;
    // The words come first: the file only when both fit beside the orb.
    return withFile.length <= textWidth() ? withFile : label;
  };
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
      <box flexDirection="row">
        <Show when={props.orb}>
          {(orb: () => OrbState) => (
            <box paddingRight={1} flexShrink={0}>
              <Orb state={orb()} seconds={props.orbSeconds} />
            </box>
          )}
        </Show>
        <box flexDirection="column" flexGrow={1}>
          <Show
            when={props.full}
            fallback={
              <>
                <text fg={failed() ? COLORS.error : COLORS.text}>
                  {spread(head(), elapsed(), textWidth())}
                </text>
                <Show when={detail()}>
                  <text fg={a().toolRunning ? COLORS.text : COLORS.muted}>
                    {clip(props.orb ? detail() : `  ${detail()}`, textWidth())}
                  </text>
                </Show>
              </>
            }
          >
            <text fg={failed() ? COLORS.error : COLORS.text}>
              {clip(
                [head().padEnd(16), tool().padEnd(36), elapsed().padStart(7), `  ${totals()}`].join(
                  "  ",
                ),
                textWidth(),
              )}
            </text>
            {/* One wide line already names the tool: under it, only the orb's words. */}
            <Show when={props.orb}>
              {(orb: () => OrbState) => <text fg={COLORS.muted}>{ORB_LABEL[orb()]}</text>}
            </Show>
          </Show>
        </box>
      </box>
      <Show when={!props.full}>
        <text fg={COLORS.muted}>{clip(`  ${totals()}`, props.width)}</text>
      </Show>
      <Show when={a().error}>
        <text fg={COLORS.error}>
          {props.full ? `  ${a().error}` : clip(`  ${a().error}`, props.width)}
        </text>
      </Show>
    </box>
  );
}
