import { homedir } from "node:os";
import type { KeyBinding, SyntaxStyle, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ModelInfo } from "../agent/models.ts";
import type { DaemonClient } from "../client/client.ts";
import type {
  JudgeState,
  PendingApproval,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";
import { ORB_LABEL } from "../orbs/activity.ts";
import { ApprovalPrompt, YoloBanner } from "./approval.tsx";
import {
  applyEvent,
  argSummary,
  initialState,
  STATUS_GLYPH,
  waitingForModel,
} from "./chat-state.ts";
import { COMMAND_WORDS, HelpPanel } from "./help.tsx";
import { promptHint, shortPath } from "./layout.ts";
import { markdownStyle } from "./markdown.ts";
import { ModelPicker } from "./model-picker.tsx";
import { animationOff, ORB_FPS, ORB_ROWS, Orb } from "./orb.tsx";
import { RAIL_WIDTH, Rail } from "./rail.tsx";
import { applyRailEvent, initialRail, railOrbState } from "./rail-state.ts";
import { parseTaskCommand } from "./task-commands.ts";

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
  /** The home folder, shown as `~` in the header. Default: the user's. */
  home?: string;
  /** Animate the thinking orbs. Default: on, unless `HAMNESS_NO_ANIMATION=1`. */
  animate?: boolean;
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
  const md = markdownStyle(useRenderer().nativeScene);
  onCleanup(() => {
    off();
    clearInterval(tick);
    md.destroy();
  });
  /** When the current wait for the model began (`waitingForModel`), for its elapsed seconds. */
  const [waitingSince, setWaitingSince] = createSignal<number | undefined>();
  createEffect(
    on(
      () => waitingForModel(state),
      (waiting) => setWaitingSince(waiting ? now() : undefined),
    ),
  );

  /**
   * The thinking orbs' clock. It ticks at `ORB_FPS` only while an orb shows (a wait for the
   * model, or an agent on the rail running or waiting on the user); idle, no timer runs.
   * `animate={false}` or `HAMNESS_NO_ANIMATION=1`: no timer at all, the orbs stand still.
   */
  const animate = props.animate ?? !animationOff();
  const [orbClock, setOrbClock] = createSignal(now());
  // A memo, so the timer only restarts when the answer flips, not on every rail change.
  const orbsShowing = createMemo(
    () =>
      waitingSince() !== undefined || rail.agents.some((a) => railOrbState(rail, a) !== undefined),
  );
  createEffect(
    on(orbsShowing, (showing) => {
      if (!showing || !animate) return;
      setOrbClock(now());
      const timer = setInterval(() => setOrbClock(now()), 1000 / ORB_FPS);
      onCleanup(() => clearInterval(timer));
    }),
  );
  const orbSeconds = () => (animate ? orbClock() / 1000 : undefined);

  const dims = useTerminalDimensions();
  /** Columns inside the chat pane: the terminal less the rail and the pane's padding. */
  const chatWidth = () => Math.max(20, dims().width - RAIL_WIDTH - 2);
  const home = props.home ?? homedir();
  /** The cwd in the header's room left after its other parts. */
  const headerPath = () => {
    const judge = state.session.mode === "auto" && state.session.judge;
    const rest =
      `hamness ·  · ${state.session.model}`.length +
      (judge ? ` · ${JUDGE_LABEL[judge]}`.length : 0) +
      (state.session.busy ? " · working…".length : 0);
    return shortPath(state.session.cwd, home, chatWidth() - rest);
  };
  let input: TextareaRenderable | undefined;
  /** Rows the prompt box shows: it grows with its lines, up to `PROMPT_MAX_ROWS`. */
  const [promptRows, setPromptRows] = createSignal(1);
  const fitPrompt = () =>
    setPromptRows(
      Math.min(PROMPT_MAX_ROWS, Math.max(1, input?.lineCount ?? 1, input?.virtualLineCount ?? 1)),
    );
  /** The `/model` picker's list while it is open. */
  const [picker, setPicker] = createSignal<ModelInfo[] | undefined>();
  /** The `/help` list while it is open. */
  const [help, setHelp] = createSignal(false);

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
    input?.clear();
    setPromptRows(1);
    setState("notice", undefined);
    setHelp(false);
    if (text === "/help" || text === "/?") return setHelp(true);
    const command = /^\/model(?:\s+(.*))?$/.exec(text);
    if (command) return modelCommand((command[1] ?? "").trim());
    if (/^\/judge\s+resume$/.test(text)) {
      props.client
        .resumeJudge(state.session.id)
        .then((judge) => setState("session", "judge", judge))
        .catch((err: Error) => setState("notice", err.message));
      return;
    }
    const taskAction = parseTaskCommand(text);
    if (taskAction) {
      if ("error" in taskAction) return setState("notice", taskAction.error);
      props.client
        .task(state.session.id, taskAction)
        .catch((err: Error) => setState("notice", err.message));
      return;
    }
    // `/word ...` that isn't a command is a typo, not a prompt (a path like /src/x.ts is).
    const word = /^(\/[a-z][\w-]*)(?:\s|$)/.exec(text)?.[1];
    if (word && !COMMAND_WORDS.has(word)) {
      return setState("notice", `unknown command ${word}: /help lists them`);
    }
    props.client
      .prompt(state.session.id, text)
      .catch((err: Error) => setState("notice", err.message));
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onExit?.();
    // Ctrl+R: the side rail full screen, and back.
    if (key.ctrl && key.name === "r") setRailFull((full) => !full);
    if (key.name === "escape" && help()) return setHelp(false);
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
            hamness · {headerPath()} · {state.session.model}
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
              item.kind === "message" ? (
                <MessageView message={item} markdown={md} />
              ) : (
                <ToolLine tool={item} />
              )
            }
          </For>
          <Show when={waitingSince() !== undefined}>
            <box flexDirection="row" paddingLeft={2} height={ORB_ROWS}>
              <Orb state="solving" seconds={orbSeconds()} />
              <text fg={COLORS.muted}>
                {` ${ORB_LABEL.solving}… ${Math.max(0, Math.floor((clock() - (waitingSince() ?? 0)) / 1000))}s`}
              </text>
            </box>
          </Show>
        </scrollbox>
        <Show when={state.notice}>
          <text fg={COLORS.error}>{state.notice}</text>
        </Show>
        <Show when={help()}>
          <HelpPanel />
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
        <box border height={promptRows() + 2}>
          <textarea
            ref={(r: TextareaRenderable) => {
              input = r;
            }}
            placeholder={promptHint(chatWidth() - 2)}
            focused={!picker() && state.approvals.length === 0}
            keyBindings={PROMPT_KEYS}
            height={promptRows()}
            onContentChange={fitPrompt}
            onSubmit={() => submit(input?.plainText ?? "")}
          />
        </box>
      </box>
      <Rail
        state={rail}
        now={clock()}
        orbSeconds={orbSeconds()}
        full={railFull()}
        {...(railFull() ? { width: Math.max(20, dims().width - 4) } : {})}
      />
    </box>
  );
}

/**
 * The prompt box: Enter sends; Shift+Enter (terminals that report it) and Ctrl+J add a
 * new line. Ctrl+J arrives as a linefeed in most terminals, or as `j` with Ctrl in kitty's.
 */
const PROMPT_MAX_ROWS = 8;
const PROMPT_KEYS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

type MessageItem = Extract<TranscriptItem, { kind: "message" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** A user prompt as typed; an assistant reply as Markdown, re-rendered as it streams. */
function MessageView(props: { message: MessageItem; markdown: SyntaxStyle }) {
  const m = () => props.message;
  return (
    <box paddingTop={m().role === "user" ? 1 : 0} flexDirection="column">
      <Show when={m().text || m().streaming}>
        <Show
          when={m().role === "assistant"}
          fallback={<text fg={COLORS.user}>{`› ${m().text}`}</text>}
        >
          <markdown
            content={m().text}
            syntaxStyle={props.markdown}
            fg={COLORS.assistant}
            streaming={m().streaming === true}
          />
        </Show>
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
