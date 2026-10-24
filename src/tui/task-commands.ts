import type { TaskAction } from "../tasks/types.ts";

/**
 * The user's task commands: `/task <goal>`, `/override [reason]`, `/abandon [reason]`.
 * Undefined when the text is not one of them (it goes to the agent as a prompt).
 */
export function parseTaskCommand(text: string): TaskAction | { error: string } | undefined {
  const m = /^\/(task|override|abandon)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const arg = (m[2] ?? "").trim();
  if (m[1] === "task") return arg ? { kind: "start", goal: arg } : { error: "usage: /task <goal>" };
  const kind = m[1] as "override" | "abandon";
  return arg ? { kind, reason: arg } : { kind };
}
