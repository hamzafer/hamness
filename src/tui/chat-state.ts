import type {
  CompactionReason,
  HamnessEvent,
  PendingApproval,
  SessionInfo,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";
import { redactSecrets } from "../safety/redact.ts";
import { plural } from "./layout.ts";
import { formatTokens } from "./rail-state.ts";

/**
 * A line hamness itself writes in the chat (a stop, a task command's answer). Client-side
 * only: it is not stored, so it is gone after a reattach.
 */
export interface SystemLine {
  kind: "system";
  id: string;
  text: string;
  tone: "muted" | "ok" | "warn" | "error";
}

export type ChatItem = TranscriptItem | SystemLine;

/** What the chat pane shows. Mutated in place by `applyEvent` (inside a Solid `produce`). */
export interface ChatState {
  session: SessionInfo;
  /** Last applied event number; older or replayed events are dropped. */
  seq: number;
  items: ChatItem[];
  /** How many system lines were added, for their ids. */
  systemLines?: number;
  /** Client-side problems (a refused prompt, a lost connection). */
  notice?: string;
  /** Tool calls waiting for the user, oldest first. */
  approvals: PendingApproval[];
  /** True while Pi compacts the context (`/compact`, or on its own). */
  compacting?: boolean;
  /** The daemon's words for the yolo banner (`safety.mode`'s `warning`), once one came. */
  yoloWarning?: string;
}

export function initialState(snapshot: SessionSnapshot): ChatState {
  return {
    session: { ...snapshot.session },
    seq: snapshot.seq,
    items: structuredClone(snapshot.items),
    approvals: structuredClone(snapshot.approvals ?? []),
  };
}

function findMessage(state: ChatState, id: string) {
  const item = state.items.find((i) => i.kind === "message" && i.id === id);
  return item?.kind === "message" ? item : undefined;
}

function findTool(state: ChatState, id: string) {
  const item = state.items.find((i) => i.kind === "tool" && i.id === id);
  return item?.kind === "tool" ? item : undefined;
}

/** Adds a system line at the end of the chat. */
export function addSystemLine(state: ChatState, text: string, tone: SystemLine["tone"]): void {
  state.systemLines = (state.systemLines ?? 0) + 1;
  state.items.push({ kind: "system", id: `sys-${state.systemLines}`, text, tone });
}

export function applyEvent(state: ChatState, e: HamnessEvent): void {
  if (!("sessionId" in e) || e.sessionId !== state.session.id || e.seq <= state.seq) return;
  state.seq = e.seq;
  // A subagent's run shows in the side rail, not the chat; only its approvals need the user.
  const main = state.session.mainAgentId;
  const fromSubagent = e.agentId !== undefined && main !== undefined && e.agentId !== main;
  if (fromSubagent && !e.type.startsWith("safety.approval.")) return;
  switch (e.type) {
    case "agent.status":
      state.session.busy = e.busy;
      return;
    case "agent.message.start":
      if (!findMessage(state, e.messageId)) {
        state.items.push({
          kind: "message",
          id: e.messageId,
          role: e.role,
          text: "",
          streaming: true,
        });
      }
      return;
    case "agent.message.delta": {
      const m = findMessage(state, e.messageId);
      if (m) m.text += e.text;
      return;
    }
    case "agent.message.end": {
      let m = findMessage(state, e.messageId);
      if (!m) {
        m = { kind: "message", id: e.messageId, role: e.role, text: "" };
        state.items.push(m);
      }
      // The daemon echoes a prompt as typed (it stores it redacted): the same live redaction
      // as a reply's, so a pasted key never shows. Replies arrive redacted already.
      m.text = e.role === "user" ? redactSecrets(e.text) : e.text;
      m.streaming = false;
      if (e.error) m.error = e.error;
      return;
    }
    case "agent.tool.start":
      if (!findTool(state, e.toolCallId)) {
        state.items.push({
          kind: "tool",
          id: e.toolCallId,
          tool: e.tool,
          args: e.args,
          status: "running",
        });
      }
      return;
    case "agent.tool.end": {
      const t = findTool(state, e.toolCallId);
      if (!t) return;
      t.status = e.status;
      t.summary = e.summary;
      if (e.durationMs !== undefined) t.durationMs = e.durationMs;
      return;
    }
    case "safety.approval.request":
      if (!state.approvals.some((a) => a.id === e.approval.id)) state.approvals.push(e.approval);
      return;
    case "safety.approval.resolved":
      state.approvals = state.approvals.filter((a) => a.id !== e.approvalId);
      return;
    case "agent.stopped":
      addSystemLine(state, "Stopped.", "muted");
      return;
    case "agent.error":
    case "agent.notice":
      state.notice = e.message;
      return;
    case "agent.model":
      state.session.model = e.model;
      if (e.billing) state.session.billing = e.billing;
      else delete state.session.billing;
      return;
    case "safety.judge": {
      const was = state.session.judge;
      state.session.judge = e.state;
      if (e.state === "paused" && was !== "paused") {
        addSystemLine(state, judgePausedLine(e.reason), "warn");
      } else if (e.state === "on" && was === "paused") {
        addSystemLine(state, JUDGE_BACK_ON, "muted");
      }
      return;
    }
    case "agent.thinking":
      state.session.thinkingLevel = e.level;
      return;
    case "session.name":
      state.session.name = e.name;
      return;
    case "safety.mode":
      state.session.mode = e.mode;
      if (e.warning) state.yoloWarning = e.warning;
      return;
    case "agent.compaction.start":
      state.compacting = true;
      return;
    case "agent.compaction.end": {
      state.compacting = false;
      if (e.error) addCompactionFailure(state, e.error);
      else if (e.aborted) addSystemLine(state, "Compaction stopped.", "muted");
      else addSystemLine(state, compactedLine(e.reason, e.tokensBefore, e.tokensAfter), "ok");
      return;
    }
    default:
      return;
  }
}

/**
 * A raw model, API or policy error as one readable line: Pi's stacked prefixes
 * (`Compaction failed: Summarization failed: …`) dropped, an API's `529 {json}` body unwrapped
 * to its message, a model refusal said plainly, and the rest kept to its first line (retry
 * hints included), at most `ERROR_MAX` characters.
 */
export function readableError(raw: string): string {
  let text = raw.trim();
  for (;;) {
    const next = text.replace(/^(compaction|summarization) failed:\s*/i, "");
    if (next === text) break;
    text = next;
  }
  const body = /^\d{3}\s+(\{[\s\S]*\})\s*$/.exec(text)?.[1];
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string" && message.trim()) text = message.trim();
    } catch {}
  }
  if (/model refused|refusal/i.test(text)) return "the model refused to write the summary.";
  const first = (text.split("\n")[0] ?? "").trim();
  const short = first.length > ERROR_MAX ? `${first.slice(0, ERROR_MAX - 1)}…` : first;
  return short || "unknown error.";
}

const ERROR_MAX = 200;

/** Pi's refusal to compact a session that has too little to summarize: not a failure. */
export const NOTHING_TO_COMPACT = "Nothing to compact yet (the session is small).";

/** `Compaction failed: …` once: the event and the command's own rejection say the same thing. */
export function addCompactionFailure(state: ChatState, raw: string): void {
  const small = /nothing to compact/i.test(raw);
  const text = small ? NOTHING_TO_COMPACT : `Compaction failed: ${readableError(raw)}`;
  const recent = state.items.slice(-3);
  if (recent.some((i) => i.kind === "system" && i.text === text)) return;
  addSystemLine(state, text, small ? "muted" : "error");
}

export const JUDGE_BACK_ON = "The judge is back on.";

/** The chat's line when the judge backs off; the daemon's reason says after how many asks. */
export function judgePausedLine(reason: string): string {
  const n = /asked (\d+) times/.exec(reason)?.[1];
  const after = n ? ` after ${plural(Number(n), "ask")}` : "";
  return `The judge paused${after}; /judge resume turns it back on`;
}

/** `Compacted: 142k → 18k tokens`, said differently when Pi did it on its own. */
export function compactedLine(reason: CompactionReason, before?: number, after?: number): string {
  const head = reason === "manual" ? "Compacted" : "Context was nearly full, so it was compacted";
  return before !== undefined && after !== undefined
    ? `${head}: ${formatTokens(before)} → ${formatTokens(after)} tokens`
    : `${head}.`;
}

/**
 * True while the agent works with nothing on screen to show for it: from the prompt to the
 * first token, and between tool calls. A running tool or an open approval shows on its own.
 */
export function waitingForModel(state: ChatState): boolean {
  if (!state.session.busy || state.approvals.length > 0) return false;
  if (state.items.some((i) => i.kind === "tool" && i.status === "running")) return false;
  const last = state.items.at(-1);
  return !(last?.kind === "message" && last.role === "assistant" && last.streaming && last.text);
}

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url"];

/** The one argument worth showing on a compact tool line. */
export function argSummary(args: Record<string, unknown>, max = 60): string {
  const key = ARG_KEYS.find((k) => typeof args[k] === "string");
  const raw = key ? String(args[key]) : JSON.stringify(args);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export const STATUS_GLYPH = { running: "…", ok: "✓", error: "✗", denied: "⊘" } as const;
