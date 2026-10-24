/**
 * Safety: allow / ask / deny rules, then the judge, then the user, with every verdict stored
 * in the decisions table (ADR 0006). See `service.ts` for the flow and `rules.ts` for matching.
 */

import type { ApprovalAnswer } from "./service.ts";

/** A tool call about to run in a session. `toolCallId` is the `tool_calls` row id. */
export interface GuardedCall {
  sessionId: string;
  toolCallId: string;
  tool: string;
  /** The model's arguments, unredacted: the check may need the real command or path. */
  args: Record<string, unknown>;
  /** The session's working directory. */
  cwd?: string;
  /** The session's transcript file, for Claude Code hooks. */
  transcriptPath?: string;
}

/** What the session hub gives a check, so it can ask the user. */
export interface SafetyContext {
  cwd: string;
  /** Shows the approval to clients and waits for an answer, a timeout or an abort. */
  askUser(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

export interface ApprovalRequest {
  toolCallId: string;
  tool: string;
  /** Redacted. */
  args: Record<string, unknown>;
  reason: string;
  suggestions: Array<{ tool: string; pattern: string }>;
  timeoutMs: number;
}

export type SafetyVerdict = { allow: true } | { allow: false; reason: string };

/** May take its time (a judge call, a user's approval in the TUI). Throwing counts as a deny. */
export type SafetyCheck = (call: GuardedCall, ctx?: SafetyContext) => Promise<SafetyVerdict>;

export const allowAll: SafetyCheck = async () => ({ allow: true });

export { redactArgs, redactText } from "./redact.ts";
export type {
  ApprovalAnswer,
  HookVerdict,
  Judge,
  JudgeRequest,
  JudgeVerdict,
  PreToolHook,
  SafetyService,
} from "./service.ts";
export { createSafetyService } from "./service.ts";
