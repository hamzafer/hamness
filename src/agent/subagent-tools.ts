import { Type } from "typebox";
import type { AgentToolSpec } from "./runner.ts";

/**
 * The tools a main agent uses to run subagents in the background (ADR 0015):
 * `agent_start` returns an id at once, `agent_status` looks, `agent_wait` blocks for the result.
 * A finished subagent nobody waited for is also delivered as a notice on the parent's next turn.
 */

export type SubagentStatus = "queued" | "running" | "done" | "error" | "aborted";

/** What the tools report about one subagent. */
export interface SubagentReport {
  id: string;
  name: string;
  status: SubagentStatus;
  model: string;
  /** The subagent's final message, once it is done. */
  result?: string;
  error?: string;
  worktree?: string;
  branch?: string;
}

export interface SubagentStart {
  name: string;
  prompt: string;
  model?: string;
  worktree?: boolean;
}

/** What the session hub provides to one parent agent's tools. */
export interface SubagentControl {
  start(req: SubagentStart): SubagentReport;
  status(id: string): SubagentReport | undefined;
  /** Resolves with the report once the subagent finished, the timeout passed or the signal fired. */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<SubagentReport | undefined>;
}

export const DEFAULT_WAIT_SEC = 300;
export const MAX_WAIT_SEC = 3600;

const json = (r: unknown) => JSON.stringify(r, null, 2);

function unknown(id: string): never {
  throw new Error(`no subagent with id ${JSON.stringify(id)} in this session`);
}

export function subagentTools(control: SubagentControl): AgentToolSpec[] {
  return [
    {
      name: "agent_start",
      label: "Start subagent",
      description:
        "Start a subagent in the background with its own prompt. Returns its id at once; " +
        "collect its final message with agent_wait (or it arrives as a notice on a later turn). " +
        "Set worktree to run it in a new git worktree on its own branch, so parallel agents " +
        "do not edit the same checkout. model is provider/id; default: your own model.",
      parameters: Type.Object({
        name: Type.String({ description: "A short name, shown in the side rail" }),
        prompt: Type.String({ description: "Everything the subagent needs to know" }),
        model: Type.Optional(Type.String({ description: "provider/id" })),
        worktree: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, args) {
        const req: SubagentStart = {
          name: String(args.name ?? ""),
          prompt: String(args.prompt ?? ""),
          ...(typeof args.model === "string" && args.model.trim() ? { model: args.model } : {}),
          ...(args.worktree === true ? { worktree: true } : {}),
        };
        return { text: json(control.start(req)) };
      },
    },
    {
      name: "agent_status",
      label: "Subagent status",
      description: "The status of a subagent you started, with its final message once done.",
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, args) {
        const id = String(args.id ?? "");
        return { text: json(control.status(id) ?? unknown(id)) };
      },
    },
    {
      name: "agent_wait",
      label: "Wait for subagent",
      description:
        `Wait for a subagent to finish and return its final message. timeoutSec defaults to ` +
        `${DEFAULT_WAIT_SEC} (at most ${MAX_WAIT_SEC}); on a timeout the status is still running.`,
      parameters: Type.Object({
        id: Type.String(),
        timeoutSec: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      async execute(_id, args, signal) {
        const id = String(args.id ?? "");
        const sec = typeof args.timeoutSec === "number" ? args.timeoutSec : DEFAULT_WAIT_SEC;
        const timeoutMs = Math.max(0, Math.min(sec, MAX_WAIT_SEC)) * 1000;
        return { text: json((await control.wait(id, timeoutMs, signal)) ?? unknown(id)) };
      },
    },
  ];
}

/** The note a parent gets when a subagent it did not wait for finishes. */
export function noticeText(r: SubagentReport): string {
  const head = `[hamness] Subagent ${r.name} (id ${r.id}) finished: ${r.status}.`;
  const where = r.worktree ? `\nWorktree: ${r.worktree} (branch ${r.branch ?? "?"})` : "";
  const body = r.status === "done" ? (r.result ?? "") : (r.error ?? "");
  return `${head}${where}\n\n${body}`.trimEnd();
}
