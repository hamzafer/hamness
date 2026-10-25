import type { CheckView, EvidenceKind, EvidenceStatus, TaskView } from "../tasks/types.ts";

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
  /** The judge's state in `auto` mode. Absent in other modes. */
  judge?: JudgeState;
  /** The name the user gave the session (`/name`). */
  name?: string;
  /** Pi's thinking level for the main agent's next model call. */
  thinkingLevel?: ThinkingLevel;
}

/** Pi's thinking levels; a model supports some of them (`GET /v1/sessions/:id/thinking`). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Why Pi compacted: the user asked (`/compact`), the context crossed the threshold, or overflowed. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** `ask`: rules, then the user. `auto`: rules, then the judge, then the user. `yolo`: allow all. */
export type SafetyMode = "ask" | "auto" | "yolo";

/**
 * The judge, as `auto` mode sees it: `on`; `paused` for the session after 3 asks in a row;
 * `over-budget` for the rest of the day; `no-key` when there is no Anthropic API key.
 * Anything but `on` means undecided calls ask the user.
 */
export type JudgeState = "on" | "paused" | "over-budget" | "no-key";

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
  /** The agent whose call it is, when that is a subagent, and its name. */
  agentId?: string;
  agentName?: string;
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
  /** The session's current task, or its last one. */
  task?: TaskView;
  /** The session's last finished proof checks, oldest first (the rail's check rows). */
  checks?: CheckView[];
}

/** One agent's stored usage. `tokens` adds input, output, cache read and cache write. */
export interface AgentTotals {
  id: string;
  kind: "main" | "subagent";
  name?: string;
  /** Subagents only: `queued`, `running`, `done`, `error` or `aborted`. */
  status?: "queued" | "running" | "done" | "error" | "aborted";
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
  /**
   * The user stopped the agent's run (Esc, or its parent was stopped). Not an error: it comes
   * before the run's last `agent.status`, in place of an `agent.error`.
   */
  | { type: "agent.stopped" }
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
  /** The session's judge changed state (paused, over budget, no key, back on). */
  | { type: "safety.judge"; state: JudgeState; reason: string }
  /** The session switched models (`provider/id`); the next model call uses it. */
  | { type: "agent.model"; model: string }
  /**
   * A subagent was started (queued until a slot is free); `agentId` is the new agent.
   * Its runs then show as `agent.status`, and a failure as `agent.error` before the last one.
   */
  | { type: "agent.start"; name: string; parentAgentId: string; model: string }
  /** The main agent's thinking level changed (`/thinking`, or Pi clamped it on a model switch). */
  | { type: "agent.thinking"; level: ThinkingLevel }
  /** Pi started compacting the context (`/compact`, or on its own near the limit). */
  | { type: "agent.compaction.start"; reason: CompactionReason }
  /**
   * Compaction ended. `tokensBefore` / `tokensAfter` are Pi's estimates of the context size;
   * `error` when it failed. An `agent.context` with the new fill follows a success.
   */
  | {
      type: "agent.compaction.end";
      reason: CompactionReason;
      aborted: boolean;
      tokensBefore?: number;
      tokensAfter?: number;
      error?: string;
    }
  /**
   * This session ended and `newSessionId` took its place in the same cwd: `/new` or `/clear`,
   * `/resume` of another session, or `/fork`. Clients attached to it switch to the new one.
   */
  | { type: "session.replaced"; newSessionId: string; reason: "new" | "resume" | "fork" }
  /** The user renamed the session (`/name`). */
  | { type: "session.name"; name: string }
  /**
   * The user set the session's safety mode (`/mode`). `warning` is set for `yolo`: clients show
   * it as a banner for as long as the mode lasts (`session.mode` in snapshots says so too).
   */
  | { type: "safety.mode"; mode: SafetyMode; warning?: string }
  | TaskEvent
);

/**
 * Task events (ticket #6). `task.start` also announces a promotion (the turn's implicit task
 * got a goal: same id, `implicit: false`). `task.drop`: an implicit turn task that held no
 * evidence and no edits was removed; it never counts as a task. `check.start` / `check.end`
 * frame one checker run (a command re-run can take minutes), before its `task.evidence`.
 */
export type TaskEvent =
  | { type: "task.start"; task: TaskView }
  | {
      type: "task.evidence";
      taskId: string;
      evidenceId: string;
      kind: EvidenceKind;
      status: Exclude<EvidenceStatus, "pending">;
      summary: string;
      /** The task's counts after this result. */
      evidence: number;
      passed: number;
    }
  | { type: "task.end"; task: TaskView }
  | { type: "task.drop"; taskId: string }
  /** A checker started on a piece of evidence (P-M3); `label` is the command, path, URL or PR. */
  | { type: "check.start"; taskId: string; evidenceId: string; kind: EvidenceKind; label: string }
  | {
      type: "check.end";
      taskId: string;
      evidenceId: string;
      status: Exclude<EvidenceStatus, "pending">;
      summary: string;
    };

export type HamnessEvent =
  | { type: "daemon.hello"; version: string; pid: number; schemaVersion: number }
  | { type: "daemon.stopping" }
  | AgentEvent;

export type HamnessEventType = HamnessEvent["type"];
