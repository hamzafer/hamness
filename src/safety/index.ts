/**
 * Safety: allow / ask / deny rules, then the judge, with every verdict stored in the decisions table (ADR 0006).
 *
 * Today this is only the hook point: every tool call passes `SafetyCheck` before it runs,
 * and the default allows everything. Ticket #4 replaces `allowAll` with rules + judge and
 * writes a `decisions` row per verdict (the `tool_calls` row already exists by then).
 */

/** A tool call about to run in a session. `toolCallId` is the `tool_calls` row id. */
export interface GuardedCall {
  sessionId: string;
  toolCallId: string;
  tool: string;
  /** The model's arguments, unredacted: the check may need the real command or path. */
  args: Record<string, unknown>;
}

export type SafetyVerdict = { allow: true } | { allow: false; reason: string };

/** May take its time (a judge call, a user's approval in the TUI). Throwing counts as a deny. */
export type SafetyCheck = (call: GuardedCall) => Promise<SafetyVerdict>;

export const allowAll: SafetyCheck = async () => ({ allow: true });

const SECRET_KEY = /(api[_-]?key|token|secret|passw(or)?d|authorization|credential)/i;

/**
 * A copy of tool arguments safe to store: values under secret-looking keys are replaced.
 * Ticket #4 extends this (secrets inside commands, `.env` contents).
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : walk(v)]),
      );
    }
    return value;
  };
  return walk(args) as Record<string, unknown>;
}
