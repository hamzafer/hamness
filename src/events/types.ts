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
}

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
}

/** Events about one session. `seq` counts up per session. */
export type AgentEvent = { sessionId: string; seq: number } & (
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
  | { type: "agent.error"; message: string }
  /** The session switched models (`provider/id`); the next model call uses it. */
  | { type: "agent.model"; model: string }
);

export type HamnessEvent =
  | { type: "daemon.hello"; version: string; pid: number; schemaVersion: number }
  | { type: "daemon.stopping" }
  | AgentEvent;

export type HamnessEventType = HamnessEvent["type"];
