import type {
  HamnessEvent,
  PendingApproval,
  SessionInfo,
  SessionSnapshot,
  TranscriptItem,
} from "../events/types.ts";

/** What the chat pane shows. Mutated in place by `applyEvent` (inside a Solid `produce`). */
export interface ChatState {
  session: SessionInfo;
  /** Last applied event number; older or replayed events are dropped. */
  seq: number;
  items: TranscriptItem[];
  /** Client-side problems (a refused prompt, a lost connection). */
  notice?: string;
  /** Tool calls waiting for the user, oldest first. */
  approvals: PendingApproval[];
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
      m.text = e.text;
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
    case "agent.error":
      state.notice = e.message;
      return;
    case "agent.model":
      state.session.model = e.model;
      return;
    default:
      return;
  }
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
