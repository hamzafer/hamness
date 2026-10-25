import { homedir } from "node:os";
import type { KeyBinding, SyntaxStyle, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { ModelInfo } from "../agent/models.ts";
import type { SessionStatus } from "../agent/session-hub.ts";
import type { DaemonClient, SessionCommands } from "../client/client.ts";
import type {
  HamnessEvent,
  JudgeState,
  PendingApproval,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";
import { ORB_LABEL } from "../orbs/activity.ts";
import { ApprovalPrompt, YoloBanner } from "./approval.tsx";
import {
  addCompactionFailure,
  addSystemLine,
  applyEvent,
  argSummary,
  initialState,
  STATUS_GLYPH,
  type SystemLine,
  waitingForModel,
} from "./chat-state.ts";
import { copyToClipboard } from "./clipboard.ts";
import { CommandMenu } from "./command-menu.tsx";
import {
  type CommandContext,
  type CommandMatch,
  errorLine,
  matchCommands,
  menuEnter,
  menuQuery,
  needsArgs,
  parseSlash,
} from "./commands.ts";
import { HelpPanel } from "./help.tsx";
import { promptHint, shortPath, wrappedRows } from "./layout.ts";
import { markdownStyle } from "./markdown.ts";
import { ModelPicker } from "./model-picker.tsx";
import { animationOff, ORB_FPS, ORB_ROWS, Orb } from "./orb.tsx";
import { Picker, type PickerSpec } from "./picker.tsx";
import { RAIL_WIDTH, Rail } from "./rail.tsx";
import { applyRailEvent, initialRail, railOrbState } from "./rail-state.ts";
import { StatusPanel } from "./status-panel.tsx";

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

/** Events for sessions the chat doesn't show, kept for a switch to one of them. */
const FOREIGN_KEPT = 500;

/** The chat's line when another client (or the daemon) replaced this session. */
const REPLACED_LINE = {
  new: "A new session started from another window.",
  resume: "Another window resumed a different session. Showing it now.",
  fork: "Another window forked this session. Showing the fork now.",
} as const;

export interface AppProps {
  client: DaemonClient & SessionCommands;
  snapshot: SessionSnapshot;
  /** Ctrl+C or `/exit`: leave the TUI. The session keeps running in the daemon. */
  onExit?: () => void;
  /** Clock for the rail's elapsed times; tests pass a fake one. */
  now?: () => number;
  /** The home folder, shown as `~` in the header. Default: the user's. */
  home?: string;
  /** Animate the thinking orbs. Default: on, unless `HAMNESS_NO_ANIMATION=1`. */
  animate?: boolean;
  /** `/copy`'s clipboard. Default: pbcopy, wl-copy or xclip, then OSC 52. */
  copy?: (text: string) => Promise<"system" | "terminal">;
  /** How long an approval ignores keys after it shows. Default 400ms; tests pass 0. */
  approvalArmMs?: number;
}

export function App(props: AppProps) {
  const [state, setState] = createStore(initialState(props.snapshot));
  const now = props.now ?? Date.now;
  const [rail, setRail] = createStore(initialRail(props.snapshot, now()));
  const [clock, setClock] = createSignal(now());
  const tick = setInterval(() => setClock(now()), 1000);
  const [railFull, setRailFull] = createSignal(false);
  /** Other sessions' events, newest last: a switch replays its new session's. */
  const foreign: HamnessEvent[] = [];
  /** The session the chat just left: its late events are never kept for a replay. */
  let left: string | undefined;
  /** How many of this client's own session switches are running (`switchTo`). */
  const [switching, setSwitching] = createSignal(0);
  /** True while following another window's replace to the new session. */
  const [following, setFollowing] = createSignal(false);
  /** Prompts sent during a switch: they go to the new session once it shows. */
  const queued: string[] = [];
  const off = props.client.subscribe((e) => {
    if ("sessionId" in e && e.sessionId !== state.session.id) {
      if (e.sessionId === left) return;
      foreign.push(e);
      if (foreign.length > FOREIGN_KEPT) foreign.splice(0, foreign.length - FOREIGN_KEPT);
      return;
    }
    if (e.type === "session.replaced" && switching() === 0) {
      // Replaced from elsewhere: follow to the cwd's live session.
      const from = state.session.id;
      setFollowing(true);
      props.client
        .attach(state.session.cwd)
        .then((snap) => {
          // Unless the chat moved on meanwhile (a switch of this client's own).
          if (state.session.id === from) replaceSession(snap, REPLACED_LINE[e.reason]);
        })
        .catch((err: Error) => setState("notice", err.message))
        .finally(() => {
          setFollowing(false);
          sendQueued();
        });
    }
    setState(produce((s) => applyEvent(s, e)));
    setRail(produce((r) => applyRailEvent(r, e, now())));
    setClock(now());
  });
  const renderer = useRenderer();
  const md = markdownStyle(renderer.nativeScene);
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
  /** When the current compaction began, for its elapsed seconds. */
  const [compactingSince, setCompactingSince] = createSignal<number | undefined>();
  createEffect(
    on(
      () => state.compacting === true,
      (compacting) => setCompactingSince(compacting ? now() : undefined),
    ),
  );

  /**
   * The thinking orbs' clock. It ticks at `ORB_FPS` only while an orb shows (a wait for the
   * model, a compaction, or an agent on the rail running or waiting on the user); idle, no
   * timer runs. `animate={false}` or `HAMNESS_NO_ANIMATION=1`: no timer at all, the orbs
   * stand still.
   */
  const animate = props.animate ?? !animationOff();
  const [orbClock, setOrbClock] = createSignal(now());
  // A memo, so the timer only restarts when the answer flips, not on every rail change.
  const orbsShowing = createMemo(
    () =>
      waitingSince() !== undefined ||
      compactingSince() !== undefined ||
      rail.agents.some((a) => railOrbState(rail, a) !== undefined),
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
  const elapsed = (since: number | undefined) =>
    Math.max(0, Math.floor((clock() - (since ?? 0)) / 1000));

  const dims = useTerminalDimensions();
  /** Columns inside the chat pane: the terminal less the rail and the pane's padding. */
  const chatWidth = () => Math.max(20, dims().width - RAIL_WIDTH - 2);
  const home = props.home ?? homedir();
  /** The judge's state for the header: in `auto`, and in `yolo` (it's back on `/mode auto`). */
  const judgeShown = () =>
    state.session.mode === "auto" || state.session.mode === "yolo"
      ? state.session.judge
      : undefined;
  /** The cwd in the header's room left after its other parts. */
  const headerPath = () => {
    const judge = judgeShown();
    const rest =
      `hamness ·  · ${state.session.model}`.length +
      (state.session.name ? `${state.session.name} · `.length : 0) +
      (judge ? ` · ${JUDGE_LABEL[judge]}`.length : 0) +
      (state.session.busy ? " · working…".length : 0);
    return shortPath(state.session.cwd, home, chatWidth() - rest);
  };
  let input: TextareaRenderable | undefined;
  /** Rows the prompt box shows: it grows with its lines, up to `PROMPT_MAX_ROWS`. */
  const [promptRows, setPromptRows] = createSignal(1);
  const fitPrompt = () =>
    setPromptRows(
      Math.min(
        PROMPT_MAX_ROWS,
        Math.max(
          1,
          input?.lineCount ?? 1,
          input?.virtualLineCount ?? 1,
          // Inside the box's border.
          wrappedRows(input?.plainText ?? "", chatWidth() - 2),
        ),
      ),
    );
  /** The `/model` picker's list while it is open. */
  const [picker, setPicker] = createSignal<ModelInfo[] | undefined>();
  /** The `/help` list while it is open. */
  const [help, setHelp] = createSignal(false);
  /** A command's pick list (`/resume`, `/fork`, `/thinking`, `/mode`) while it is open. */
  const [list, setList] = createSignal<PickerSpec | undefined>();
  /** The open picker's filter: kept here so it survives an approval hiding the picker. */
  const [pickQuery, setPickQuery] = createSignal("");
  /** The `/status` panel while it is open. */
  const [status, setStatus] = createSignal<SessionStatus | undefined>();

  /** The input box's text, for the `/` menu. */
  const [draft, setDraft] = createSignal("");
  const [menuIndex, setMenuIndex] = createSignal(0);
  /** The highlight was moved with the arrows: Enter runs that row. */
  const [menuMoved, setMenuMoved] = createSignal(false);
  /** Esc closed the menu; it stays closed until the text changes. */
  const [menuClosed, setMenuClosed] = createSignal(false);
  const matches = createMemo((): CommandMatch[] => {
    const q = menuQuery(draft());
    return q === undefined ? [] : matchCommands(q);
  });
  const menuOpen = () =>
    matches().length > 0 && !menuClosed() && !picker() && !list() && state.approvals.length === 0;
  const onDraft = () => {
    fitPrompt();
    const text = input?.plainText ?? "";
    if (text === draft()) return;
    setDraft(text);
    setMenuIndex(0);
    setMenuMoved(false);
    setMenuClosed(false);
  };
  const setInput = (text: string) => {
    input?.setText(text);
    input?.gotoBufferEnd();
    setDraft(text);
    setMenuIndex(0);
    setMenuMoved(false);
    fitPrompt();
  };

  const say = (text: string, tone: SystemLine["tone"] = "muted") =>
    setState(produce((s) => addSystemLine(s, text, tone)));
  const closePanels = () => {
    setHelp(false);
    setStatus(undefined);
  };

  /** Shows another session in place of this one: its transcript, rail and mode, then `line`. */
  const replaceSession = (snap: SessionSnapshot, line: string) => {
    if (snap.session.id === state.session.id) return;
    left = state.session.id;
    setState(reconcile(initialState(snap)));
    setRail(reconcile(initialRail(snap, now())));
    const missed = foreign.filter((e) => "sessionId" in e && e.sessionId === snap.session.id);
    foreign.length = 0;
    for (const e of missed) {
      setState(produce((s) => applyEvent(s, e)));
      setRail(produce((r) => applyRailEvent(r, e, now())));
    }
    setPicker(undefined);
    setList(undefined);
    closePanels();
    say(line);
  };

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
      .then((models) => {
        if (!models.length) {
          setState("notice", "No models available: add a key with `hamness keys set <provider>`");
          return;
        }
        setPickQuery("");
        setPicker(models);
      })
      .catch((err: Error) => setState("notice", err.message));
  };

  const ctx: CommandContext = {
    client: props.client,
    home,
    session: () => state.session,
    say,
    patchSession: (patch) => setState("session", patch),
    pick: (spec) => {
      setPickQuery("");
      setList(spec);
    },
    showHelp: () => setHelp(true),
    showStatus: (s) => setStatus(s),
    model: modelCommand,
    switchTo: async (call, line) => {
      setSwitching((n) => n + 1);
      try {
        const snap = await call();
        replaceSession(snap, line(snap));
        return snap;
      } catch (err) {
        say(...errorLine(err));
        return undefined;
      } finally {
        setSwitching((n) => n - 1);
        sendQueued();
      }
    },
    compactionFailed: (message) => setState(produce((s) => addCompactionFailure(s, message))),
    setInput,
    prompts: () =>
      state.items.flatMap((i) =>
        i.kind === "message" && i.role === "user" && i.text ? [{ id: i.id, text: i.text }] : [],
      ),
    copy: props.copy ?? ((text) => copyToClipboard(text, (t) => renderer.copyToClipboardOSC52(t))),
    exit: () => props.onExit?.(),
  };

  const sendPrompt = (text: string) =>
    props.client
      .prompt(state.session.id, text)
      .catch((err: Error) => setState("notice", err.message));
  /** After a switch: the prompts typed meanwhile go to the session now showing. */
  const sendQueued = () => {
    if (following() || switching() > 0) return;
    for (const text of queued.splice(0)) sendPrompt(text);
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    input?.clear();
    setDraft("");
    setPromptRows(1);
    setState("notice", undefined);
    closePanels();
    // A leading space sends a line that starts with a slash as a message.
    const slash = /^\s/.test(value) ? undefined : parseSlash(text);
    if (slash && "unknown" in slash) {
      if (slash.unknown === "/") return say("Type / to see commands.", "muted");
      return say(
        `Unknown command ${slash.unknown}. Type / to see commands. To send it as a message, start with a space.`,
        "warn",
      );
    }
    if (slash) {
      Promise.resolve()
        .then(() => slash.command.run(ctx, slash.arg))
        .catch((err: unknown) => say(...errorLine(err)));
      return;
    }
    if (following() || switching() > 0) {
      // The session is being replaced: not to the one that is ending.
      queued.push(text);
      say("Switching sessions. Your prompt goes to the new one.");
      return;
    }
    sendPrompt(text);
  };

  /** Tab, or Enter on a command that needs arguments: the name in the input box, ready for them. */
  const complete = (m: CommandMatch) => setInput(m.command.args ? `${m.label} ` : m.label);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onExit?.();
    // Ctrl+R: the side rail full screen, and back.
    if (key.ctrl && key.name === "r") setRailFull((full) => !full);
    // An approval owns the keys (its prompt answers them); pickers and panels wait under it.
    if (state.approvals.length > 0) return;
    if (menuOpen()) {
      const n = matches().length;
      const enter = (key.name === "return" || key.name === "kpenter") && !key.shift;
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        setMenuIndex((i) => (i + (key.name === "up" ? n - 1 : 1)) % n);
        setMenuMoved(true);
        return;
      }
      if (key.name === "tab" || enter) {
        key.preventDefault();
        const m = matches()[Math.min(menuIndex(), n - 1)];
        if (!m) return;
        if (key.name === "tab") return complete(m);
        const what = menuEnter(menuQuery(draft()) ?? "", matches(), menuIndex(), menuMoved());
        // A bare `/`: the menu stays open to pick from.
        if (what.kind === "hint") return;
        if (what.kind === "complete" || needsArgs(what.match.command)) return complete(what.match);
        return submit(what.match.label);
      }
      if (key.name === "escape") {
        key.preventDefault();
        setMenuClosed(true);
        return;
      }
    }
    if (key.name === "escape" && (help() || status())) return closePanels();
    if (
      key.name === "escape" &&
      state.session.busy &&
      !picker() &&
      !list() &&
      !state.approvals.length
    ) {
      props.client.abort(state.session.id).catch(() => {});
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <Show when={state.session.mode === "yolo"}>
        <YoloBanner />
      </Show>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          visible={!railFull()}
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexDirection="row" height={1} flexShrink={0}>
            <text fg={COLORS.muted}>hamness · </text>
            <Show when={state.session.name}>
              {(name: () => string) => <text fg={COLORS.assistant}>{`${name()} · `}</text>}
            </Show>
            <text fg={COLORS.muted}>
              {headerPath()} · {state.session.model}
            </text>
            <Show when={judgeShown()}>
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
          {/* The scrollbar keeps its column even while it has nothing to scroll: text wraps short
              of it, so it never covers a line's last character when it appears. */}
          <scrollbox
            stickyScroll
            stickyStart="bottom"
            flexGrow={1}
            minHeight={0}
            contentOptions={{ paddingRight: 1 }}
          >
            <Show when={!state.items.some((i) => i.kind === "message" && i.role === "user")}>
              <text fg={COLORS.muted}>
                {`  ${shortPath(state.session.cwd, home, Math.max(10, chatWidth() - 60))} · ${state.session.model} · Type / for commands`}
              </text>
            </Show>
            <For each={state.items}>
              {(item) =>
                item.kind === "message" ? (
                  <MessageView message={item} markdown={md} />
                ) : item.kind === "system" ? (
                  <SystemLineView line={item} />
                ) : (
                  <ToolLine tool={item} />
                )
              }
            </For>
            <Show when={waitingSince() !== undefined}>
              <box flexDirection="row" paddingLeft={2} height={ORB_ROWS}>
                <Orb state="solving" seconds={orbSeconds()} />
                <text fg={COLORS.muted}>
                  {` ${ORB_LABEL.solving}… ${elapsed(waitingSince())}s`}
                </text>
              </box>
            </Show>
            <Show when={compactingSince() !== undefined}>
              <box flexDirection="row" paddingLeft={2} height={ORB_ROWS}>
                <Orb state="shaping" seconds={orbSeconds()} />
                <text fg={COLORS.muted}>
                  {` Compacting the context… ${elapsed(compactingSince())}s`}
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
          <Show when={status()}>
            {(s: () => SessionStatus) => <StatusPanel status={s()} home={home} />}
          </Show>
          <Show when={state.approvals.length === 0 && list()}>
            {(spec: () => PickerSpec) => (
              <Picker
                spec={spec()}
                onClose={() => setList(undefined)}
                query={pickQuery()}
                onQuery={setPickQuery}
              />
            )}
          </Show>
          <Show when={state.approvals.length === 0 && picker()}>
            {(models: () => ModelInfo[]) => (
              <ModelPicker
                models={models()}
                current={state.session.model}
                onPick={switchModel}
                onClose={() => setPicker(undefined)}
                query={pickQuery()}
                onQuery={setPickQuery}
              />
            )}
          </Show>
          <Show when={state.approvals[0]}>
            {(first: () => PendingApproval) => (
              <ApprovalPrompt
                approval={first()}
                queued={state.approvals.length}
                width={chatWidth()}
                maxHeight={Math.max(6, Math.floor(dims().height / 2))}
                {...(props.approvalArmMs !== undefined ? { armMs: props.approvalArmMs } : {})}
                onAnswer={(decision) =>
                  props.client
                    .answerApproval(first().id, decision)
                    .catch((err: Error) => setState("notice", err.message))
                }
              />
            )}
          </Show>
          <Show when={menuOpen()}>
            <CommandMenu matches={matches()} selected={menuIndex()} width={chatWidth()} />
          </Show>
          <box border height={promptRows() + 2}>
            <textarea
              ref={(r: TextareaRenderable) => {
                input = r;
              }}
              placeholder={promptHint(chatWidth() - 2)}
              focused={!picker() && !list() && state.approvals.length === 0}
              keyBindings={PROMPT_KEYS}
              height={promptRows()}
              onContentChange={onDraft}
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
    </box>
  );
}

/**
 * The prompt box: Enter sends; Shift+Enter (terminals that report it) and Ctrl+J add a
 * new line. Ctrl+J arrives as a linefeed in most terminals, or as `j` with Ctrl in kitty's.
 */
const PROMPT_MAX_ROWS = 6;
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

/** A line from hamness itself: a stop, a command's answer. */
function SystemLineView(props: { line: SystemLine }) {
  return <text fg={COLORS[props.line.tone]}>{`  ${props.line.text}`}</text>;
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
