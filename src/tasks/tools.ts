import { Type } from "typebox";
import type { AgentToolSpec } from "../agent/runner.ts";
import { PROVE_PARAMETERS } from "./claims.ts";
import type { CheckResult, TaskView } from "./types.ts";

/** What the agent's task tools reach. Deliberately no override, abandon or result setter. */
export interface TaskToolHandle {
  start(goal: string): TaskView;
  done(summary: string): TaskView;
  /** `toolCallId` is Pi's id for the `prove` call. */
  prove(
    input: Record<string, unknown>,
    toolCallId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ result: CheckResult; task: TaskView }>;
}

/** Added to the system prompt: the proof gate in a few lines, and how to change files. */
export const PROOF_GATE_PROMPT = `## Tasks and proof (hamness)
Work happens in tasks. Call task_start(goal) when you begin a piece of work, and task_done(summary) when it is finished.
Before task_done, attach evidence with prove: a command hamness re-runs itself (tests, build, lint), a file you produced, a URL to fetch, or a PR/commit whose CI hamness reads. hamness checks the evidence; you cannot mark it passed.
A task is verified only if its latest check passed after your last file change. Commands that prove nothing (echo, true, cat, ls, \`|| true\`) are refused; tests, builds, linters and typecheckers count. A file you wrote yourself, or a check after you edited its package.json, Makefile or test config, is weak evidence and does not verify alone. Otherwise the task closes as unverified, shown in red to the user. Only the user can override that. If a check fails, fix the problem and prove again.

## Changing files (hamness)
Create and change files with the edit and write tools. Use bash only to run things (tests, builds, git, scripts), never to write files: no heredocs, \`cat >\`, \`echo >\`, \`tee\` or \`sed -i\`. hamness cannot check a command that writes files, so it asks the user every time, and a write through bash after a check counts as a file change that needs a new proof.`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The agent's three task tools, bound to one session. */
export function taskTools(handle: TaskToolHandle): AgentToolSpec[] {
  return [
    {
      name: "task_start",
      label: "Start task",
      description:
        "Open a task for the work you are about to do. Its cost, time and evidence are tracked; close it with task_done.",
      parameters: Type.Object(
        { goal: Type.String({ description: "What done looks like, in one line." }) },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const task = handle.start(String(params.goal ?? ""));
        return {
          text: `Task open: ${task.goal}. Attach evidence with prove, then call task_done.`,
          details: { taskId: task.id },
        };
      },
    },
    {
      name: "prove",
      label: "Prove",
      description:
        "Attach evidence to the open task. hamness checks it itself: command (re-run in the session folder, exit 0 passes), file (exists, non-empty, written during the task, inside the session folder; weak if you wrote it yourself), url (fetched, 2xx passes) or ci (a PR or commit; every check must pass).",
      parameters: PROVE_PARAMETERS,
      async execute(id, params, signal) {
        const { result, task } = await handle.prove(params, id, signal);
        const tail =
          result.status !== "passed" && typeof result.details.outputTail === "string"
            ? `\nOutput tail:\n${result.details.outputTail.slice(-1500)}`
            : "";
        return {
          text: `Evidence ${result.status}: ${result.summary}. Task has ${plural(task.passed, "passing piece")} of ${plural(task.evidence, "checked piece")}.${tail}`,
          details: { status: result.status, taskId: task.id },
        };
      },
    },
    {
      name: "task_done",
      label: "Finish task",
      description:
        "Close the open task. It is verified only if the latest evidence passed hamness's check after your last file change; otherwise unverified.",
      parameters: Type.Object(
        { summary: Type.String({ description: "What was done, in a sentence or two." }) },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const task = handle.done(String(params.summary ?? ""));
        const why =
          task.outcome === "verified"
            ? `${plural(task.passed, "piece")} of evidence passed`
            : `${task.unverifiedReason ?? "no evidence passed"}; only the user can override it`;
        return {
          text: `Task closed as ${task.outcome} (${why}).`,
          details: { taskId: task.id, outcome: task.outcome },
        };
      },
    },
  ];
}
