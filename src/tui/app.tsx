import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ModelInfo } from "../agent/models.ts";
import type { DaemonClient } from "../client/client.ts";
import type {
  JudgeState,
  PendingApproval,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";
import { ApprovalPrompt, YoloBanner } from "./approval.tsx";
import { applyEvent, argSummary, initialState, STATUS_GLYPH } from "./chat-state.ts";
import { ModelPicker } from "./model-picker.tsx";
import { RAIL_WIDTH, Rail } from "./rail.tsx";
import { applyRailEvent, initialRail, type RailTask } from "./rail-state.ts";

const COLORS = {
  user: "#7aa2f7",
  assistant: "#c0caf5",
  muted: "#737aa2",
  ok: "#9ece6a",
  error: "#f7768e",
  warn: "#e0af68",
};

export { RAIL_WIDTH };

/** The header's judge note in `auto` mode. */
const JUDGE_LABEL: Record<JudgeState, string> = {
  on: "judge on",
  paused: "judge paused (/judge resume)",
  "over-budget": "judge over budget",
  "no-key": "judge off: no key",
};

export interface AppProps {
  client: DaemonClient;
  snapshot: SessionSnapshot;
  /** Ctrl+C: leave the TUI. The session keeps running in the daemon. */
  onExit?: () => void;
  /** Clock for the rail's elapsed times; tests pass a fake one. */
  now?: () => number;
  /** The current task for the rail's top slot (ticket #6). */
  task?: RailTask;
}

export function App(props: AppProps) {
  const [state, setState] = createStore(initialState(props.snapshot));
  const now = props.now ?? Date.now;
  const [rail, setRail] = createStore(initialRail(props.snapshot, now()));
  const [clock, setClock] = createSignal(now());
  const tick = setInterval(() => setClock(now()), 1000);
  const [railFull, setRailFull] = createSignal(false);
  const off = props.client.subscribe((e) => {
    setState(produce((s) => applyEvent(s, e)));
    setRail(produce((r) => applyRailEvent(r, e, now())));
    setClock(now());
  });
  onCleanup(() => {
    off();
    clearInterval(tick);
  });

  const dims = useTerminalDimensions();
  let input: InputRenderable | undefined;
  /** The `/model` picker's list while it is open. */
  const [picker, setPicker] = createSignal<ModelInfo[] | undefined>();

  const switchModel = (model: string) => {
    setPicker(undefined);
    props.client
      .setModel(state.session.id, model)
      .then((snap) => setState("session", "model", snap.session.model))
      .catch((err: Error) => setState("notice", err.message));
  };

  /** `/model` opens the picker; `/model provider/id` switches straight away. */
  const modelCommand = (arg: string) => {
    if (arg) return switchModel(arg);
    props.client
      .models()
      .then((models) =>
        models.length
          ? setPicker(models)
          : setState("notice", "No models available: add a key with `hamness keys set <provider>`"),
      )
      .catch((err: Error) => setState("notice", err.message));
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    if (input) input.value = "";
    setState("notice", undefined);
    const command = /^\/model(?:\s+(.*))?$/.exec(text);
    if (command) return modelCommand((command[1] ?? "").trim());
    if (/^\/judge\s+resume$/.test(text)) {
      props.client
        .resumeJudge(state.session.id)
        .then((judge) => setState("session", "judge", judge))
        .catch((err: Error) => setState("notice", err.message));
      return;
    }
    props.client
      .prompt(state.session.id, text)
      .catch((err: Error) => setState("notice", err.message));
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onExit?.();
    // Ctrl+R: the side rail full screen, and back.
    if (key.ctrl && key.name === "r") setRailFull((full) => !full);
    if (key.name === "escape" && state.session.busy && !picker() && !state.approvals.length) {
      props.client.abort(state.session.id).catch(() => {});
    }
  });

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box
        visible={!railFull()}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <Show when={state.session.mode === "yolo"}>
          <YoloBanner />
        </Show>
        <box flexDirection="row" height={1}>
          <text fg={COLORS.muted}>
            hamness · {state.session.cwd} · {state.session.model}
          </text>
          <Show when={state.session.mode === "auto" && state.session.judge}>
            {(judge: () => JudgeState) => (
              <text fg={judge() === "on" ? COLORS.muted : COLORS.warn}>
                {` · ${JUDGE_LABEL[judge()]}`}
              </text>
            )}
          </Show>
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
        <Show when={picker()}>
          {(models: () => ModelInfo[]) => (
            <ModelPicker
              models={models()}
              current={state.session.model}
              onPick={switchModel}
              onClose={() => setPicker(undefined)}
            />
          )}
        </Show>
        <Show when={state.approvals[0]}>
          {(first: () => PendingApproval) => (
            <ApprovalPrompt
              approval={first()}
              queued={state.approvals.length}
              onAnswer={(decision) =>
                props.client
                  .answerApproval(first().id, decision)
                  .catch((err: Error) => setState("notice", err.message))
              }
            />
          )}
        </Show>
        <box border height={3}>
          <input
            ref={(r: InputRenderable) => {
              input = r;
            }}
            placeholder="Ask hamness… (Enter sends, Esc stops, /model switches, Ctrl+C leaves)"
            focused={!picker() && state.approvals.length === 0}
            onSubmit={(v: unknown) => submit(typeof v === "string" ? v : (input?.value ?? ""))}
          />
        </box>
      </box>
      <Rail
        state={rail}
        now={clock()}
        full={railFull()}
        {...(props.task ? { task: props.task } : {})}
        {...(railFull() ? { width: Math.max(20, dims().width - 4) } : {})}
      />
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
