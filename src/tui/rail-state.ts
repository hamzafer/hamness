import type { ContextFill, HamnessEvent, SessionSnapshot } from "../events/types.ts";
import { activityOrbState } from "../orbs/activity.ts";
import type { OrbState } from "../orbs/index.ts";
import type { EvidenceKind, EvidenceStatus, TaskView } from "../tasks/types.ts";

/**
 * What the side rail shows, built only from the session snapshot and the daemon's events.
 * Pure: `applyRailEvent` mutates the state in place (inside a Solid `produce`) and takes the
 * clock as an argument, so tests drive it without rendering or waiting.
 */

/** `done`: the last run finished cleanly. `idle`: no run yet. */
export type RailStatus = "idle" | "running" | "done" | "error";

export interface RailAgent {
  id: string;
  /** Checks have their own rows (`RailCheck`). Pi's bash has no background shells (ADR 0019). */
  kind: "main" | "subagent";
  name: string;
  status: RailStatus;
  /** The newest tool call still running; cleared when it ends and when the run ends. */
  tool?: string;
  /** Basename of that call's file argument, if it has one. */
  file?: string;
  toolRunning: boolean;
  /** Start and end of the current or last run (client clock, ms). */
  startedAt?: number;
  endedAt?: number;
  /** Input, output, cache read and cache write tokens added up. */
  tokens: number;
  costMicros: number;
  error?: string;
  /** Tool calls still running, oldest first. */
  open: Array<{ id: string; tool: string; file?: string }>;
  /** Assistant text is arriving (for its orb). */
  streaming: boolean;
  /** Its approvals waiting for the user. */
  approvals: string[];
}

/** The session's current (or last) task, from the snapshot and `task.*` events. */
export interface RailTask {
  id: string;
  goal: string;
  implicit: boolean;
  outcome: TaskView["outcome"];
  /** Evidence checked, and how many pieces passed. */
  evidence: number;
  passed: number;
}

function railTask(t: TaskView): RailTask {
  return {
    id: t.id,
    goal: t.goal,
    implicit: t.implicit,
    outcome: t.outcome,
    evidence: t.evidence,
    passed: t.passed,
  };
}

/** One checker run of the proof gate (P-M3): a command re-run, a fetch, a file, a CI read. */
export interface RailCheck {
  id: string;
  kind: EvidenceKind;
  label: string;
  status: "running" | Exclude<EvidenceStatus, "pending">;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

/** Checks kept on the rail: the newest few. */
export const RAIL_CHECKS = 3;

export interface RailState {
  sessionId: string;
  mainAgentId: string;
  seq: number;
  agents: RailAgent[];
  checks: RailCheck[];
  context?: ContextFill;
  task?: RailTask;
}

const MAIN_FALLBACK_ID = "main";
const FILE_KEYS = ["path", "file_path", "filePath", "file"];

/** The basename of a tool call's file argument. */
export function fileOf(args: Record<string, unknown>): string | undefined {
  const key = FILE_KEYS.find((k) => typeof args[k] === "string" && args[k] !== "");
  if (!key) return undefined;
  const parts = String(args[key]).split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
}

function newAgent(id: string, kind: RailAgent["kind"], name: string): RailAgent {
  return {
    id,
    kind,
    name,
    status: "idle",
    toolRunning: false,
    tokens: 0,
    costMicros: 0,
    open: [],
    streaming: false,
    approvals: [],
  };
}

export function initialRail(snapshot: SessionSnapshot, now: number): RailState {
  const mainAgentId = snapshot.session.mainAgentId ?? MAIN_FALLBACK_ID;
  const agents = (snapshot.agents ?? []).map((a) => {
    const row = newAgent(a.id, a.kind, a.kind === "main" ? "main" : (a.name ?? shortId(a.id)));
    row.tokens = a.tokens;
    row.costMicros = a.costMicros;
    if (a.status === "running") {
      row.status = "running";
      row.startedAt = now;
    } else if (a.status === "done") row.status = "done";
    else if (a.status === "error" || a.status === "aborted") row.status = "error";
    return row;
  });
  if (!agents.some((a) => a.id === mainAgentId)) {
    agents.unshift(newAgent(mainAgentId, "main", "main"));
  }
  const state: RailState = {
    sessionId: snapshot.session.id,
    mainAgentId,
    seq: snapshot.seq,
    agents,
    checks: [],
  };
  if (snapshot.context) state.context = { ...snapshot.context };
  if (snapshot.task) state.task = railTask(snapshot.task);

  const main = agentFor(state, mainAgentId);
  for (const a of snapshot.approvals ?? []) {
    agentFor(state, a.agentId ?? mainAgentId).approvals.push(a.id);
  }
  if (snapshot.session.busy) {
    main.status = "running";
    main.startedAt = now;
    for (const item of snapshot.items) {
      if (item.kind === "tool" && item.status === "running") {
        startTool(main, item.id, item.tool, item.args);
      }
    }
  }
  return state;
}

function shortId(id: string): string {
  return id.slice(-6);
}

function agentFor(state: RailState, id: string | undefined): RailAgent {
  const key = id ?? state.mainAgentId;
  let agent = state.agents.find((a) => a.id === key);
  if (!agent) {
    agent = newAgent(key, "subagent", shortId(key));
    state.agents.push(agent);
  }
  return agent;
}

function startTool(agent: RailAgent, id: string, tool: string, args: Record<string, unknown>) {
  const file = fileOf(args);
  agent.open.push({ id, tool, ...(file ? { file } : {}) });
  showTool(agent, tool, file, true);
}

function showTool(agent: RailAgent, tool: string, file: string | undefined, running: boolean) {
  agent.tool = tool;
  if (file) agent.file = file;
  else delete agent.file;
  agent.toolRunning = running;
}

function clearTool(agent: RailAgent) {
  delete agent.tool;
  delete agent.file;
  agent.toolRunning = false;
}

export function applyRailEvent(state: RailState, e: HamnessEvent, now: number): void {
  if (!("sessionId" in e) || e.sessionId !== state.sessionId || e.seq <= state.seq) return;
  state.seq = e.seq;
  const agent = agentFor(state, e.agentId);
  switch (e.type) {
    case "agent.start":
      agent.name = e.name;
      return;
    case "agent.status":
      if (e.busy) {
        agent.status = "running";
        agent.startedAt = now;
        delete agent.endedAt;
        delete agent.error;
      } else if (agent.status === "running") {
        agent.status = agent.error ? "error" : "done";
        agent.endedAt = now;
        agent.open = [];
        agent.streaming = false;
        clearTool(agent);
      }
      return;
    case "agent.message.start":
      agent.streaming = false;
      return;
    case "agent.message.delta":
      agent.streaming = true;
      return;
    case "safety.approval.request":
      if (!agent.approvals.includes(e.approval.id)) agent.approvals.push(e.approval.id);
      return;
    case "safety.approval.resolved":
      for (const a of state.agents) a.approvals = a.approvals.filter((id) => id !== e.approvalId);
      return;
    case "agent.tool.start":
      startTool(agent, e.toolCallId, e.tool, e.args);
      return;
    case "agent.tool.end": {
      agent.open = agent.open.filter((t) => t.id !== e.toolCallId);
      const still = agent.open.at(-1);
      if (still) showTool(agent, still.tool, still.file, true);
      else clearTool(agent);
      return;
    }
    case "agent.usage":
      agent.tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      agent.costMicros += e.costMicros;
      return;
    case "agent.context":
      if (agent.id === state.mainAgentId) {
        state.context = { tokens: e.tokens, contextWindow: e.contextWindow, percent: e.percent };
      }
      return;
    case "agent.message.end":
      agent.streaming = false;
      if (e.error) setError(agent, e.error, now);
      return;
    case "agent.error":
      setError(agent, e.message, now);
      return;
    case "task.start":
    case "task.end":
      state.task = railTask(e.task);
      return;
    case "task.evidence":
      if (state.task?.id === e.taskId) {
        state.task.evidence = e.evidence;
        state.task.passed = e.passed;
      }
      return;
    case "task.drop":
      if (state.task?.id === e.taskId) delete state.task;
      return;
    case "check.start":
      state.checks.push({
        id: e.evidenceId,
        kind: e.kind,
        label: e.label,
        status: "running",
        startedAt: now,
      });
      if (state.checks.length > RAIL_CHECKS)
        state.checks.splice(0, state.checks.length - RAIL_CHECKS);
      return;
    case "check.end": {
      const check = state.checks.find((c) => c.id === e.evidenceId);
      if (check) {
        check.status = e.status;
        check.summary = e.summary;
        check.endedAt = now;
      }
      return;
    }
    default:
      return;
  }
}

function setError(agent: RailAgent, message: string, now: number) {
  agent.error = message;
  if (agent.status !== "running") {
    agent.status = "error";
    agent.endedAt ??= now;
  }
}

/** The agent's thinking orb (see `activityOrbState`); proof checks count for the main agent. */
export function railOrbState(state: RailState, agent: RailAgent): OrbState | undefined {
  return activityOrbState({
    running: agent.status === "running",
    approvals: agent.approvals.length,
    ...(agent.toolRunning && agent.tool ? { tool: agent.tool } : {}),
    streaming: agent.streaming,
    checking: agent.id === state.mainAgentId && state.checks.some((c) => c.status === "running"),
  });
}

export function sessionCostMicros(state: RailState): number {
  return state.agents.reduce((sum, a) => sum + a.costMicros, 0);
}

/** How long the current run has taken, or the last run took. Undefined before any run. */
export function elapsedMs(agent: RailAgent, now: number): number | undefined {
  if (agent.startedAt === undefined) return undefined;
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, "");
}

/** Micro-dollars as dollars: cents above $1, otherwise enough digits to see small costs. */
export function formatCost(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export const RAIL_GLYPH: Record<RailStatus, string> = {
  idle: "○",
  running: "●",
  done: "✓",
  error: "✗",
};
