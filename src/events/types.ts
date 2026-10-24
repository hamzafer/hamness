/**
 * Everything the daemon streams to clients over `/v1/events`, and the session shapes its HTTP API returns.
 * Later tickets add task and decision events to this union.
 */

export interface SessionInfo {
  id: string;
  cwd: string;
  /** `provider/model`. */
  model: string;
  busy: boolean;
  /** The safety mode for this session's tool calls (ADR 0006). Absent when no rules apply (tests). */
  mode?: SafetyMode;
  /** The session's main agent; events with this `agentId` (or none) are about it. */
  mainAgentId?: string;
}

/** `ask`: rules, then the user. `auto`: rules, then the judge, then the user. `yolo`: allow all. */
export type SafetyMode = "ask" | "auto" | "yolo";

/** A tool call waiting for the user's answer. Answer it with `POST /v1/approvals/:id`. */
export interface PendingApproval {
  id: string;
  /** The `tool_calls` row. */
  toolCallId: string;
  tool: string;
  /** Redacted. */
  args: Record<string, unknown>;
  /** Why it asks. */
  reason: string;
  /** What "allow always" saves to the project config. Empty: only once / deny are offered. */
  suggestions: Array<{ tool: string; pattern: string }>;
  /** When it turns into a deny (ms since the epoch). */
  expiresAt: number;
}

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ToolStatus = "running" | "ok" | "error" | "denied";

/** One row of a session's transcript, as a client draws it. */
export type TranscriptItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      /** True while the reply is still streaming. */
      streaming?: boolean;
      error?: string;
    }
  | {
      kind: "tool";
      id: string;
      tool: string;
      args: Record<string, unknown>;
      status: ToolStatus;
      summary?: string;
      durationMs?: number;
    };

/**
 * What `POST /v1/sessions` and `GET /v1/sessions/:id` return. `seq` is the last event number
 * already reflected in `items`: a client drops session events with `seq <= snapshot.seq`.
 */
export interface SessionSnapshot {
  session: SessionInfo;
  seq: number;
  items: TranscriptItem[];
  /** Tool calls waiting for an answer. */
  approvals?: PendingApproval[];
  /** Stored totals per agent, so a client's gauges start where the database is. */
  agents?: AgentTotals[];
  /** The main agent's last known context fill. */
  context?: ContextFill;
}

/** One agent's stored usage. `tokens` adds input, output, cache read and cache write. */
export interface AgentTotals {
  id: string;
  kind: "main" | "subagent";
  name?: string;
  tokens: number;
  costMicros: number;
}

/** How full an agent's context window is (Pi's estimate). `tokens` is null right after compaction. */
export interface ContextFill {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * Events about one session. `seq` counts up per session. `agentId` names the agent the event
 * is about; when it is missing the event is about the session's main agent.
 */
export type AgentEvent = { sessionId: string; seq: number; agentId?: string } & (
  | { type: "agent.status"; busy: boolean }
  | { type: "agent.message.start"; messageId: string; role: "user" | "assistant" }
  | { type: "agent.message.delta"; messageId: string; text: string }
  | {
      type: "agent.message.end";
      messageId: string;
      role: "user" | "assistant";
      text: string;
      error?: string;
    }
  | {
      type: "agent.tool.start";
      toolCallId: string;
      messageId?: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: "agent.tool.end";
      toolCallId: string;
      status: Exclude<ToolStatus, "running">;
      summary: string;
      durationMs?: number;
    }
  | {
      type: "agent.usage";
      modelCallId: string;
      messageId: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costMicros: number;
      /** False when hamness's price table has no entry and the cost is Pi's estimate. */
      priced: boolean;
    }
  | ({ type: "agent.context" } & ContextFill)
  | { type: "agent.error"; message: string }
  /** Something the user should know that is not an error (a hook blocked a prompt, ...). */
  | { type: "agent.notice"; message: string }
  | { type: "safety.approval.request"; approval: PendingApproval }
  | {
      type: "safety.approval.resolved";
      approvalId: string;
      decision: "allow" | "deny";
      /** `user` answered, `timeout` ran out, `abort`: the run was stopped. */
      by: "user" | "timeout" | "abort";
    }
  /** The session switched models (`provider/id`); the next model call uses it. */
  | { type: "agent.model"; model: string }
);

export type HamnessEvent =
  | { type: "daemon.hello"; version: string; pid: number; schemaVersion: number }
  | { type: "daemon.stopping" }
  | AgentEvent;

export type HamnessEventType = HamnessEvent["type"];
