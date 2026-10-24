import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { DaemonClient } from "../client/client.ts";
import type { SessionSnapshot, TranscriptItem } from "../events/types.ts";
import { applyEvent, argSummary, initialState, STATUS_GLYPH } from "./chat-state.ts";

const COLORS = {
  user: "#7aa2f7",
  assistant: "#c0caf5",
  muted: "#737aa2",
  ok: "#9ece6a",
  error: "#f7768e",
  warn: "#e0af68",
};

/** Width kept for the side rail (ticket #3 fills it). */
export const RAIL_WIDTH = 32;

export interface AppProps {
  client: DaemonClient;
  snapshot: SessionSnapshot;
  /** Ctrl+C: leave the TUI. The session keeps running in the daemon. */
  onExit?: () => void;
}

export function App(props: AppProps) {
  const [state, setState] = createStore(initialState(props.snapshot));
  const off = props.client.subscribe((e) => setState(produce((s) => applyEvent(s, e))));
  onCleanup(off);

  let input: InputRenderable | undefined;

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    if (input) input.value = "";
    setState("notice", undefined);
    props.client
      .prompt(state.session.id, text)
      .catch((err: Error) => setState("notice", err.message));
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onExit?.();
    if (key.name === "escape" && state.session.busy) {
      props.client.abort(state.session.id).catch(() => {});
    }
  });

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" height={1}>
          <text fg={COLORS.muted}>
            hamness · {state.session.cwd} · {state.session.model}
          </text>
          <Show when={state.session.busy}>
            <text fg={COLORS.warn}> · working…</text>
          </Show>
        </box>
        <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} minHeight={0}>
          <For each={state.items}>
            {(item) =>
              item.kind === "message" ? <MessageView message={item} /> : <ToolLine tool={item} />
            }
          </For>
        </scrollbox>
        <Show when={state.notice}>
          <text fg={COLORS.error}>{state.notice}</text>
        </Show>
        <box border height={3}>
          <input
            ref={(r: InputRenderable) => {
              input = r;
            }}
            placeholder="Ask hamness… (Enter sends, Esc stops, Ctrl+C leaves)"
            focused
            onSubmit={(v: unknown) => submit(typeof v === "string" ? v : (input?.value ?? ""))}
          />
        </box>
      </box>
      <box width={RAIL_WIDTH} border title="side rail" flexDirection="column" paddingLeft={1}>
        <text fg={COLORS.muted}>agents, tools, task and cost show here soon</text>
      </box>
    </box>
  );
}

type MessageItem = Extract<TranscriptItem, { kind: "message" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

function MessageView(props: { message: MessageItem }) {
  const m = () => props.message;
  return (
    <box paddingTop={m().role === "user" ? 1 : 0} flexDirection="column">
      <Show when={m().text || m().streaming}>
        <text fg={m().role === "user" ? COLORS.user : COLORS.assistant}>
          {m().role === "user" ? `› ${m().text}` : m().text}
        </text>
      </Show>
      <Show when={m().error}>
        <text fg={COLORS.error}>error: {m().error}</text>
      </Show>
    </box>
  );
}

/** One line per tool call: status, tool, its main argument, then time or why it failed. */
function ToolLine(props: { tool: ToolItem }) {
  const t = () => props.tool;
  const tail = () => {
    const { status, summary, durationMs } = t();
    if (status === "denied") return `  denied: ${summary ?? ""}`;
    const time = durationMs !== undefined ? `  ${durationMs}ms` : "";
    const why = status === "error" ? `  ${(summary ?? "").split("\n")[0]}` : "";
    return `${time}${why}`;
  };
  const failed = () => t().status === "error" || t().status === "denied";
  return (
    <text fg={failed() ? COLORS.error : COLORS.muted}>
      {`  ${STATUS_GLYPH[t().status]} ${t().tool}  ${argSummary(t().args)}${tail()}`}
    </text>
  );
}
