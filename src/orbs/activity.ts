import type { HamnessEvent } from "../events/types.ts";
import type { OrbState } from "./types.ts";

/**
 * Which orb an agent gets, from what it is doing right now. The TUI's rail and the dashboard
 * both feed this, so an agent shows the same orb in each.
 */
export interface Activity {
  /**
   * Its run is going: `agent.status` busy, or for `LiveRuns` any sign of work since (a client
   * that joins mid-run never saw the busy event). Only `agent.status` not busy ends it.
   */
  running: boolean;
  /** Tool calls waiting for the user's answer. */
  approvals: number;
  /** The newest tool call still running. */
  tool?: string;
  /** Assistant text is arriving. */
  streaming: boolean;
  /** A proof check is running for it. */
  checking: boolean;
}

/** What the user reads beside an orb: their words for what is going on, not state names. */
export const ORB_LABEL: Record<OrbState, string> = {
  solving: "Thinking",
  searching: "Searching the code",
  shaping: "Editing files",
  working: "Running commands",
  composing: "Writing the reply",
  listening: "Waiting for you",
};

const SEARCH_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "notebookedit"]);

/** Reading and searching sweep the globe; edits shape; bash and the rest work. */
export function toolOrbState(tool: string): OrbState {
  const name = tool.toLowerCase();
  if (SEARCH_TOOLS.has(name)) return "searching";
  if (EDIT_TOOLS.has(name)) return "shaping";
  return "working";
}

/**
 * An approval listens (the agent waits on the user); then a running tool by its kind; a check
 * works; streaming text composes; otherwise the agent waits on the model and solves. No orb
 * when nothing runs.
 */
export function activityOrbState(a: Activity): OrbState | undefined {
  if (a.approvals > 0) return "listening";
  if (!a.running) return undefined;
  if (a.tool) return toolOrbState(a.tool);
  if (a.checking) return "working";
  if (a.streaming) return "composing";
  return "solving";
}

interface LiveAgent extends Activity {
  /** Tool calls still running, oldest first. */
  open: Array<{ id: string; tool: string }>;
  /** Pending approval ids. */
  approvalIds: Set<string>;
  checks: Set<string>;
  /** Order of the last event about it, so the newest busy agent picks the orb. */
  touched: number;
}

/**
 * Every agent's activity across the daemon, from the event stream alone (the dashboard has no
 * snapshot). A page opened mid-run, or back from a reconnect, picks the run up from its next
 * tool, text, check or approval event. Agents that finished with nothing waiting are dropped.
 */
export class LiveRuns {
  private agents = new Map<string, LiveAgent>();
  private clock = 0;

  apply(e: HamnessEvent): void {
    if (e.type === "daemon.stopping") {
      this.agents.clear();
      return;
    }
    if (!("sessionId" in e)) return;
    const key = `${e.sessionId}/${e.agentId ?? ""}`;
    let a = this.agents.get(key);
    if (!a) {
      a = {
        running: false,
        approvals: 0,
        streaming: false,
        checking: false,
        open: [],
        approvalIds: new Set(),
        checks: new Set(),
        touched: 0,
      };
      this.agents.set(key, a);
    }
    // An answer is about the waiting agent, not the one the event names.
    if (e.type !== "safety.approval.resolved") a.touched = ++this.clock;
    switch (e.type) {
      case "agent.status":
        a.running = e.busy;
        if (!e.busy) {
          a.open = [];
          a.streaming = false;
          a.checks.clear();
        }
        break;
      case "agent.message.delta":
        a.running = true;
        a.streaming = true;
        break;
      case "agent.message.start":
        a.running = true;
        a.streaming = false;
        break;
      case "agent.message.end":
        a.streaming = false;
        break;
      case "agent.tool.start":
        a.running = true;
        a.open.push({ id: e.toolCallId, tool: e.tool });
        break;
      case "agent.tool.end":
        a.open = a.open.filter((t) => t.id !== e.toolCallId);
        break;
      case "safety.approval.request":
        a.running = true;
        a.approvalIds.add(e.approval.id);
        break;
      case "safety.approval.resolved":
        // The answer can come from anyone; drop the id wherever it waits.
        for (const other of this.agents.values()) {
          other.approvalIds.delete(e.approvalId);
          other.approvals = other.approvalIds.size;
        }
        break;
      case "check.start":
        a.running = true;
        a.checks.add(e.evidenceId);
        break;
      case "check.end":
        a.checks.delete(e.evidenceId);
        break;
      default:
        break;
    }
    const tool = a.open.at(-1)?.tool;
    if (tool) a.tool = tool;
    else delete a.tool;
    a.approvals = a.approvalIds.size;
    a.checking = a.checks.size > 0;
    // Forget agents with no run and nothing waiting: finished ones, and late events (usage,
    // context) about an agent that has stopped.
    for (const [k, other] of this.agents) {
      if (!other.running && other.approvals === 0) this.agents.delete(k);
    }
  }

  /** How many agents it still tracks. */
  tracked(): number {
    return this.agents.size;
  }

  /** Agents with a run going or an approval waiting. */
  active(): number {
    return [...this.agents.values()].filter((a) => activityOrbState(a) !== undefined).length;
  }

  /** The orb for the daemon as a whole: any approval listens, else the newest busy agent's. */
  state(): OrbState | undefined {
    const live = [...this.agents.values()].filter((a) => activityOrbState(a) !== undefined);
    if (live.some((a) => a.approvals > 0)) return "listening";
    const newest = live.sort((x, y) => y.touched - x.touched)[0];
    return newest ? activityOrbState(newest) : undefined;
  }
}
