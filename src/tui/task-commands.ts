import type { TaskAction, TaskView } from "../tasks/types.ts";

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

/** The chat's one-line answer to a task command the daemon accepted. */
export function taskConfirmation(action: TaskAction, task: TaskView): string {
  if (action.kind === "start") return `Task opened: ${task.goal}`;
  const reason = task.reason ?? action.reason;
  // The rail's word for it, so both say the same.
  const head = action.kind === "override" ? "Task accepted without proof" : "Task abandoned";
  return reason ? `${head}: ${reason}` : `${head}.`;
}
