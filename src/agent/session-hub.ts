import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type ClaudeHooks,
  claudePermissionMode,
  type HookSession,
  type SessionStartSource,
} from "../compat/hooks.ts";
import { type ClaudeEnv, type CompatSetup, loadCompat } from "../compat/index.ts";
import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type {
  AgentEvent,
  ApprovalDecision,
  ContextFill,
  JudgeState,
  PendingApproval,
  SafetyMode,
  SessionInfo,
  SessionSnapshot,
  ThinkingLevel,
  TranscriptItem,
} from "../events/types.ts";
import { costMicros } from "../models/prices.ts";
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  allowAll,
  redactArgs,
  redactSecrets,
  redactText,
  type SafetyCheck,
} from "../safety/index.ts";
import { loadProofConfig } from "../safety/proof.ts";
import { broadWorkspace } from "../safety/rules.ts";
import { type GhRunner, runGh } from "../tasks/checkers/index.ts";
import { gitBranch, SessionTasks } from "../tasks/session-tasks.ts";
import { PROOF_GATE_PROMPT, taskTools } from "../tasks/tools.ts";
import type { TaskAction, TaskView } from "../tasks/types.ts";
import { isSubscriptionBilling } from "./billing.ts";
import { explainModelError } from "./errors.ts";
import {
  billingLabel,
  listModels,
  type ModelChoice,
  type ModelInfo,
  modelName,
  PLAN_UNSUPPORTED_ERROR,
  parseModelSpec,
  planModel,
} from "./models.ts";
import { readPlanLogin } from "./plan.ts";
import { ReplyRedactor } from "./reply-redact.ts";
import {
  type AgentRunner,
  type BranchFrom,
  type CompactionOutcome,
  type RunnerEvent,
  startAgentRunner,
  type ToolGuard,
  type ToolVerdict,
} from "./runner.ts";
import { ChatStore, type RowIds, type SessionUsage, type StoredSession } from "./store.ts";
import {
  noticeText,
  type SubagentControl,
  type SubagentReport,
  type SubagentStart,
  type SubagentStatus,
  subagentTools,
} from "./subagent-tools.ts";
import { createWorktree } from "./worktrees.ts";

/** Distributive Omit, so each event keeps its own fields. */
type EventBody = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "sessionId" | "seq">
    : never
  : never;

export interface SessionHubOptions {
  db: HamnessDb;
  /** hamness's data dir; Pi's config and session files live under `<dataDir>/pi`. */
  dataDir: string;
  /** Resolved on first use, so the daemon starts without an API key. */
  models: () => Promise<ModelChoice>;
  safety?: SafetyCheck;
  /**
   * The safety modes: a session's own (`/mode`), else its cwd's from the config. Shown to clients
   * (the yolo banner). Without it there are no modes (tests with a fixed safety check).
   */
  safetyModes?: {
    modeFor(cwd: string, sessionId?: string): SafetyMode | undefined;
    setSessionMode(sessionId: string, mode: SafetyMode | undefined): void;
  };
  /** The judge's state per session, and `/judge resume` (auto mode only). */
  judge?: { state(sessionId: string): JudgeState; resume(sessionId: string): boolean };
  publish: (event: AgentEvent) => void;
  /** Load Claude Code's instructions, skills and MCP servers (ADR 0008). Default true. */
  contextFiles?: boolean;
  /** How many subagents run at once across the daemon; more wait in a queue. Default 4. */
  maxSubagents?: number;
  /** Where Claude Code's files are (`HOME`, `CLAUDE_CONFIG_DIR`). Default: the process env. */
  claude?: ClaudeEnv;
  /** How `ci` evidence runs `gh`, and how `url` evidence fetches. Tests pass fakes. */
  gh?: GhRunner;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Claude Code hooks for session starts, prompts, tool results and stops (PreToolUse is in `safety`). */
  hooks?: Omit<ClaudeHooks, "preToolUse">;
}

/** `provider/id` to its provider. */
const providerOf = (model: string) => model.split("/")[0];

/** `plan` or `api` for a session's model (`provider/id`); undefined when unknown. */
const billingKind = (models: ModelChoice, model: string) =>
  models.billing?.(providerOf(model) ?? "")?.kind;

/** What a reply with no text, no tool call and no error shows (ADR 0024). */
export const SILENT_REPLY =
  "The model ended without a reply or an error. On a ChatGPT plan this model may not be on your tier; try /model.";

export const DEFAULT_MAX_SUBAGENTS = 4;
/** Stop hooks may continue a turn this many times in a row (Claude Code's cap). */
export const STOP_HOOK_CAP = 8;

/** A model the session cannot switch to: not in the catalog, or no credentials for it. */
export class ModelSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSwitchError";
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super("the session is already running a prompt");
    this.name = "SessionBusyError";
  }
}

/** One running agent loop's state: the session's main agent, or a subagent. */
interface AgentState {
  agentId: string;
  cwd: string;
  runner: AgentRunner;
  busy: boolean;
  /** Assistant message rows by the runner's key, with their text so far. */
  /** `redact` sends the reply's deltas with secrets out (`ReplyRedactor`); `text` is raw. */
  replies: Map<string, { rowId: string; text: string; done: boolean; redact: ReplyRedactor }>;
  /** The latest assistant message row; tool calls after it belong to it. */
  currentReplyRow: string | undefined;
  /** `tool_calls` row ids by Pi's tool call id. */
  tools: Map<string, string>;
  denied: Map<string, string>;
  /** The newest finished reply: a subagent's result. */
  lastText?: string;
  lastError?: string;
  /** Subagents: the parent's task when started, which their rows count toward. */
  taskId?: string;
  /** Subagents: the name the parent gave it. */
  name?: string;
  /** When the current run started (busy since): its time goes to `sessions.active_ms`. */
  runStartedAt?: number | undefined;
}

/** The session is its main agent's state, plus what the session shares. */
interface LiveSession extends AgentState {
  id: string;
  /** The Pi runtime (and starting model) the session was built with; switches use its catalog. */
  models: ModelChoice;
  seq: number;
  /** Tool calls waiting for the user, by approval id (any agent of the session). */
  approvals: Map<string, PendingEntry>;
  /** The main agent's subagents, by agent id. */
  subagents: Map<string, Subagent>;
  /** The session's tasks: the per-turn task, the agent's task tools, the proof gate. */
  tasks: SessionTasks;
  /** Claude Code instructions, skills and MCP servers; subagents get the same (ADR 0015). */
  compat?: CompatSetup;
  /** SessionStart hooks; the first prompt waits for them. */
  ready: Promise<void>;
  /** SessionStart hook context and notice, for the first prompt. */
  startContext?: string | undefined;
  startNotice?: string | undefined;
  /** Why the session's stored model was swapped for the default; shown with the first prompt. */
  modelNotice?: string | undefined;
  /** The last reply was the ChatGPT plan refusing the model; switch when the run settles. */
  planFallback?: boolean;
  /** Set once the "runs in your home folder or /" notice went out. */
  broadNoticeShown?: boolean;
  /** The text of the last reply, for Stop hooks. */
  lastReply: string;
  /** True while a Stop hook keeps the turn going; `stopStreak` counts it (tool calls reset it). */
  stopActive: boolean;
  stopStreak: number;
  /** Bumped by abort, so a Stop hook that answers after it doesn't restart the run. */
  runGen: number;
  /**
   * The session's rows wait for its first prompt or task (`persist`), so a client that attaches
   * and leaves (a TUI opened in the wrong folder) leaves no empty session behind (#25).
   */
  unsaved?: { piSessionId: string | undefined; startedAt: number } | undefined;
  /** The user message row whose Pi entry id comes next (`user.entry`), for `/fork`. */
  pendingUserRow?: string | undefined;
  /** True during `/compact`, and while `/new`, `/resume` or `/fork` replaces the session. */
  compacting: boolean;
  replacing: boolean;
  /** SessionStart hooks or a model switch still under way: not idle, so it never sleeps. */
  inFlight: number;
  /** `/name`. */
  sessionName?: string | undefined;
  /** The mode the user set for this session (`/mode`), if any. */
  ownMode?: SafetyMode | undefined;
}

/**
 * How a client's launch picks its session (ADR 0023): `new`, a fresh chat (plain `hamness`);
 * `continue`, the cwd's latest session (`-c`); `session`, that one (`-r <id>`, and a client
 * coming back to the session it had).
 */
export type Launch = { kind: "new" } | { kind: "continue" } | { kind: "session"; id: string };

/** What a session that slept before its first prompt keeps for when it wakes. */
interface Carried {
  model: string;
  thinkingLevel: ThinkingLevel;
  ownMode?: SafetyMode | undefined;
  name?: string | undefined;
}

/** Sessions put to sleep before their first prompt, remembered for a wake (in memory only). */
const ASLEEP_KEPT = 200;

/** How `create` starts a session's agent. */
type StartPlan =
  /** A fresh session; `ids` and `carry` when one that slept unsaved wakes. */
  | { kind: "fresh"; ids?: { sessionId: string; agentId: string }; carry?: Carried }
  /** `/new`: a fresh session; settings and an open explicit task carry over from `from`. */
  | { kind: "new"; from: LiveSession }
  /** `file` is missing for a session that never had a prompt (a task holder): Pi starts a new one. */
  | { kind: "resume"; stored: StoredSession; file?: string }
  /** `/fork`: Pi's history up to `branch.leafId`, and the transcript before `beforeMessageId`. */
  | { kind: "fork"; from: LiveSession; branch: BranchFrom; beforeMessageId: string };

/** A session command the session's state or the request doesn't allow; `status` is the HTTP one. */
export class SessionCommandError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "SessionCommandError";
  }
}

/** A 400 when a session asked for in `wanted`'s folder belongs to another one. */
function sameFolder(actual: string, wanted: string | undefined): void {
  if (wanted !== undefined && actual !== wanted) {
    throw new SessionCommandError("that session belongs to another folder", 400);
  }
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const asThinking = (v: string | undefined): ThinkingLevel | undefined =>
  (THINKING_LEVELS as readonly string[]).includes(v ?? "") ? (v as ThinkingLevel) : undefined;
const SAFETY_MODES: readonly SafetyMode[] = ["ask", "auto", "yolo"];
export const YOLO_WARNING =
  "yolo mode: tool calls run with no question or judge. Deny rules still block direct references to secrets, and a call hamness cannot see past (a recursive search over secrets, a heredoc, a path in a variable) still asks; yolo cannot see inside scripts and interpreters. Switch back with /mode auto.";
export const SESSION_NAME_MAX = 200;

/** One session of `GET /v1/sessions?cwd=`. */
export interface SessionListItem {
  id: string;
  name?: string;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  costMicros: number;
  /** The main agent's first prompt, for a session with no name. */
  firstPrompt?: string;
  /** The cwd's live session now. */
  current: boolean;
  /** Pi still has its session file, so `/resume` can continue it. */
  resumable: boolean;
}

/** `GET /v1/sessions/:id/status` (`/session`, `/status`). */
export interface SessionStatus {
  sessionId: string;
  name?: string;
  cwd: string;
  branch?: string;
  model: string;
  /** How the model is paid for: `plan` (ChatGPT subscription) or `api` (pay per token). */
  billing?: "plan" | "subscription" | "api";
  thinkingLevel: ThinkingLevel;
  busy: boolean;
  context?: ContextFill;
  /** Stored usage over all the session's agents. */
  tokens: SessionUsage["tokens"];
  costMicros: number;
  /** Model calls billed to the ChatGPT plan ($0 each). */
  planCalls?: number;
  /** Pi's counts for the main agent's session file. */
  messages: { user: number; assistant: number; toolCalls: number };
  task?: TaskView;
  mode?: SafetyMode;
  /** `session`: set with `/mode`; `config`: the user config's mode. */
  modeSource?: "session" | "config";
  judge?: JudgeState;
  /** Pi's session file. */
  sessionFile?: string;
}

/** `GET /v1/sessions/:id/compat`: what the session loaded from Claude Code's setup. */
export interface SessionCompat {
  skills: Array<{
    name: string;
    description: string;
    scope: "user" | "project";
    userInvocable: boolean;
    modelInvocable: boolean;
  }>;
  mcpServers: Array<{
    name: string;
    scope: string;
    /** The configured policy: `start`, `needs-approval`, `disabled`, `unsupported`. */
    status: string;
    reason?: string;
    /**
     * For a `start` server: the tools it has registered in this session so far. Above 0, it
     * connected; 0 means still connecting, failed, or a server with no tools (Pi's MCP client
     * does not expose its connection state).
     */
    tools?: number;
  }>;
}

interface Subagent {
  id: string;
  name: string;
  prompt: string;
  model: string;
  wantsWorktree: boolean;
  session: LiveSession;
  taskId?: string;
  status: SubagentStatus;
  /** Set once it runs. */
  agent?: AgentState;
  result?: string;
  error?: string;
  worktree?: string;
  branch?: string;
  stopping: boolean;
  /** `agent_wait` calls waiting for it; when there are none at the end, a notice goes out. */
  waiters: Set<() => void>;
}

const FINISHED: ReadonlySet<SubagentStatus> = new Set(["done", "error", "aborted"]);

interface PendingEntry {
  approval: PendingApproval;
  settle: (answer: ApprovalAnswer) => void;
}

/**
 * Owns the live sessions: one main agent per working directory, kept running after
 * clients detach. Turns runner events into stored rows and published events.
 */
export class SessionHub {
  private readonly store: ChatStore;
  private readonly byId = new Map<string, LiveSession>();
  /** ChatGPT plan models the backend refused (or answered with nothing) since the daemon started. */
  private readonly refusedPlanModels = new Set<string>();
  /**
   * The last event number of each session this daemon ran. A resumed session goes on from it
   * (seq counts up per session id, across lives), so a client never drops its new events.
   */
  private readonly lastSeqs = new Map<string, number>();
  /** The newest live session started per cwd, for `continue` when the cwd has none stored. */
  private readonly byCwd = new Map<string, Promise<LiveSession>>();
  /** Sessions waking now, so two requests for one never start two agents. */
  private readonly waking = new Map<string, Promise<LiveSession>>();
  /** Sessions that slept before their first prompt: nothing is stored to wake them from. */
  private readonly asleep = new Map<
    string,
    { cwd: string; ids: { sessionId: string; agentId: string }; carry: Carried }
  >();
  private readonly safety: SafetyCheck;
  /** Subagents waiting for a slot, oldest first, and how many run now. */
  private readonly queue: Subagent[] = [];
  private running = 0;

  constructor(private readonly opts: SessionHubOptions) {
    this.store = new ChatStore(opts.db);
    this.safety = opts.safety ?? allowAll;
    this.store.abortStaleSubagents();
  }

  /**
   * A client's session in `cwd` (ADR 0023). `new` starts a fresh one with the default model and
   * puts the cwd's idle sessions to sleep; its snapshot names an open task another session
   * holds (`openTask`). `continue` is the cwd's latest session, `session` the one with that id
   * (an ended one too): live, or woken from SQLite and Pi's file.
   */
  async attach(cwd: string, how: Launch = { kind: "continue" }): Promise<SessionSnapshot> {
    if (how.kind === "session") {
      const live = await this.wake(how.id, { cwd, ended: true });
      if (!live.unsaved) this.store.makeLatest(live.id, live.cwd);
      return this.snapshotOf(live);
    }
    if (how.kind === "new") {
      this.sleepIdle(cwd);
      const live = await this.track(cwd, this.create(cwd));
      const openTask = this.store.openTaskIn(cwd, live.id);
      return { ...this.snapshotOf(live), ...(openTask ? { openTask } : {}) };
    }
    return this.snapshotOf(await this.latest(cwd));
  }

  /** `continue`: the cwd's last stored session, else its newest live one, else a new one. */
  private async latest(cwd: string): Promise<LiveSession> {
    const last = this.store.latestSession(cwd);
    // `/new` left the last stored one: the session that replaced it is live, not stored yet.
    const left = !!last && this.store.wasLeft(last.sessionId);
    if (last && !left) {
      const woken = await this.wakeResumable(last.sessionId, cwd);
      if (woken) return woken;
    }
    const newest = this.byCwd.get(cwd);
    const live = newest && (await newest.catch(() => undefined));
    if (live && this.byId.get(live.id) === live) return live;
    if (last && left) {
      const woken = await this.wakeResumable(last.sessionId, cwd);
      if (woken) return woken;
    }
    return this.track(cwd, this.create(cwd));
  }

  /**
   * `-c`: wakes the session and keeps it the cwd's latest; undefined when Pi's file is gone
   * (no context to come back to).
   */
  private async wakeResumable(id: string, cwd: string): Promise<LiveSession | undefined> {
    try {
      const live = await this.wake(id, { cwd, ended: true });
      this.store.makeLatest(live.id, cwd);
      return live;
    } catch (err) {
      if (err instanceof SessionCommandError && err.status === 409) return undefined;
      throw err;
    }
  }

  private track(cwd: string, pending: Promise<LiveSession>): Promise<LiveSession> {
    this.byCwd.set(cwd, pending);
    pending.catch(() => {
      if (this.byCwd.get(cwd) === pending) this.byCwd.delete(cwd);
    });
    return pending;
  }

  /**
   * Wakes a session that a fresh launch put to sleep, or one from before a daemon restart, so
   * a request to it works (a second window's next prompt). An ended session stays ended.
   */
  async ensureAwake(sessionId: string): Promise<void> {
    if (this.byId.has(sessionId)) return;
    try {
      await this.wake(sessionId, { ended: false });
    } catch (err) {
      // No such session, or Pi's file is gone: the route answers as for any unknown session.
      if (err instanceof SessionCommandError && (err.status === 404 || err.status === 409)) {
        return;
      }
      throw err;
    }
  }

  /**
   * The session `id`, live: as it is, or woken (started again under the same ids). `cwd`: it
   * must belong to that folder (400). `ended`: a session `/new`, `/resume` or `/fork` left
   * may wake too (an explicit `--resume`).
   */
  private wake(id: string, opts: { cwd?: string; ended: boolean }): Promise<LiveSession> {
    const live = this.byId.get(id);
    if (live) {
      sameFolder(live.cwd, opts.cwd);
      return Promise.resolve(live);
    }
    const pending = this.waking.get(id);
    if (pending) {
      return pending.then((l) => {
        sameFolder(l.cwd, opts.cwd);
        return l;
      });
    }
    return this.starting(id, this.revive(id, opts));
  }

  /**
   * Registers the start of a stored session's agent under its id, so a wake and a `/resume`
   * of one id never start two agents: whichever comes second waits for the first.
   */
  private starting(id: string, start: Promise<LiveSession>): Promise<LiveSession> {
    this.waking.set(id, start);
    const done = () => {
      if (this.waking.get(id) === start) this.waking.delete(id);
    };
    start.then(done, done);
    return start;
  }

  private async revive(id: string, opts: { cwd?: string; ended: boolean }): Promise<LiveSession> {
    const slept = this.asleep.get(id);
    if (slept) {
      sameFolder(slept.cwd, opts.cwd);
      const live = await this.create(slept.cwd, {
        kind: "fresh",
        ids: slept.ids,
        carry: slept.carry,
      });
      this.asleep.delete(id);
      return live;
    }
    const stored = this.store.session(id);
    if (!stored) throw new SessionCommandError("no such session", 404);
    sameFolder(stored.cwd, opts.cwd);
    if (!opts.ended && this.store.wasLeft(id)) {
      throw new SessionCommandError("no such session", 404);
    }
    const file = SessionManager.findById(stored.cwd, stored.piSessionId, this.sessionDir);
    // A session with no message (one holding a task moved by `/new`) never had a Pi file.
    if (!file && this.store.hasMessages(id)) {
      throw new SessionCommandError("Pi's file for that session is gone", 409);
    }
    return this.create(stored.cwd, { kind: "resume", stored, ...(file ? { file } : {}) });
  }

  /**
   * A fresh launch puts the cwd's idle sessions to sleep: the daemon keeps no agent (and no MCP
   * servers) per launch. Rows and Pi's file stay, as after a daemon stop; the next request to
   * one wakes it (`ensureAwake`). A busy session, or one with a question or a subagent out,
   * stays up.
   */
  private sleepIdle(cwd: string): void {
    for (const live of [...this.byId.values()]) {
      if (live.cwd !== cwd || !this.idle(live)) continue;
      this.byId.delete(live.id);
      live.runGen += 1;
      void live.runner.dispose();
      this.opts.safetyModes?.setSessionMode(live.id, undefined);
      if (!live.unsaved) continue;
      this.asleep.set(live.id, {
        cwd,
        ids: { sessionId: live.id, agentId: live.agentId },
        carry: {
          model: live.runner.model,
          thinkingLevel: live.runner.thinkingLevel,
          ownMode: live.ownMode,
          name: live.sessionName,
        },
      });
      for (const old of this.asleep.keys()) {
        if (this.asleep.size <= ASLEEP_KEPT) break;
        this.asleep.delete(old);
      }
    }
  }

  private idle(live: LiveSession): boolean {
    return (
      !live.busy &&
      !live.compacting &&
      !live.replacing &&
      live.inFlight === 0 &&
      live.approvals.size === 0 &&
      [...live.subagents.values()].every((sub) => FINISHED.has(sub.status))
    );
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const live = this.byId.get(sessionId);
    return live && this.snapshotOf(live);
  }

  /** Starts a prompt and returns the user message id; the reply streams as events. */
  prompt(sessionId: string, text: string): string | undefined {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    if (live.busy || live.compacting || live.replacing) throw new SessionBusyError();
    this.persist(live);
    // The session prompted last is the one `--continue` picks.
    this.store.makeLatest(live.id, live.cwd);

    // Stored redacted (message and task goal); the live stream echoes the prompt as typed.
    live.tasks.beginTurn(redactText(text));
    const messageId = this.store.addMessage(this.ids(live), "user", redactText(text));
    live.pendingUserRow = messageId;
    this.emit(live, { type: "agent.message.start", messageId, role: "user" });
    this.emit(live, { type: "agent.message.end", messageId, role: "user", text });
    this.setBusy(live, live, true);
    this.send(live, text).catch((err: unknown) => this.failRun(live, err));
    return messageId;
  }

  /** Writes the session's rows on its first prompt or task; see `LiveSession.unsaved`. */
  private persist(live: LiveSession): void {
    const unsaved = live.unsaved;
    if (!unsaved) return;
    this.store.createSession(live.cwd, live.runner.model, unsaved.piSessionId, {
      ids: { sessionId: live.id, agentId: live.agentId },
      startedAt: unsaved.startedAt,
    });
    live.unsaved = undefined;
    this.saveSettings(live);
  }

  /** The session's name, thinking level and own mode, on its row. */
  private saveSettings(live: LiveSession): void {
    if (live.unsaved) return;
    this.store.setSessionSettings(live.id, {
      ...(live.sessionName ? { name: live.sessionName } : {}),
      thinkingLevel: live.runner.thinkingLevel,
      ...(live.ownMode ? { safetyMode: live.ownMode } : {}),
    });
  }

  private failRun(live: LiveSession, err: unknown): void {
    const message = (err as Error).message ?? String(err);
    this.emit(live, {
      type: "agent.error",
      message: explainModelError(message, this.opts.dataDir, providerOf(live.runner.model)),
    });
    live.tasks.endTurn();
    this.setBusy(live, live, false);
  }

  private hookSession(live: LiveSession): HookSession {
    const file = live.runner.sessionFile;
    return {
      sessionId: live.id,
      cwd: live.cwd,
      ...(file ? { transcriptPath: file } : {}),
      permissionMode: claudePermissionMode(this.modeOf(live)),
    };
  }

  /** Runs UserPromptSubmit hooks, then sends the prompt (with any hook context) to the model. */
  private async send(live: LiveSession, text: string): Promise<void> {
    live.stopActive = false;
    live.stopStreak = 0;
    if (live.modelNotice) {
      this.emit(live, { type: "agent.notice", message: live.modelNotice });
      live.modelNotice = undefined;
    }
    if (!live.broadNoticeShown && broadWorkspace(live.cwd, homedir())) {
      live.broadNoticeShown = true;
      this.emit(live, {
        type: "agent.notice",
        message: `This session runs in ${live.cwd}, your home folder or /. Writes there ask instead of being allowed as the project's; start hamness in a project folder for the usual rules.`,
      });
    }
    const hooks = this.opts.hooks;
    if (!hooks) return live.runner.prompt(text);
    await live.ready;
    if (live.startNotice) {
      this.emit(live, { type: "agent.notice", message: live.startNotice });
      live.startNotice = undefined;
    }
    const submitted = await hooks.userPromptSubmit(this.hookSession(live), text);
    if (submitted.blocked) {
      this.emit(live, {
        type: "agent.notice",
        message: `A UserPromptSubmit hook blocked the prompt: ${submitted.blocked}`,
      });
      live.tasks.endTurn();
      this.setBusy(live, live, false);
      return;
    }
    const extra = [
      live.startContext && `SessionStart hook additional context:\n${live.startContext}`,
      submitted.context && `UserPromptSubmit hook additional context:\n${submitted.context}`,
    ].filter(Boolean);
    live.startContext = undefined;
    const body = extra.length
      ? `${text}\n\n<system-reminder>\n${extra.join("\n\n")}\n</system-reminder>`
      : text;
    await live.runner.prompt(body);
  }

  /** The run settled: Stop hooks may keep it going, up to `STOP_HOOK_CAP` times in a row. */
  private async afterRun(live: LiveSession, aborted: boolean): Promise<void> {
    live.pendingUserRow = undefined;
    const hooks = this.opts.hooks;
    const gen = live.runGen;
    let reason: string | undefined;
    if (hooks && !aborted) {
      reason = (
        await hooks.stop(this.hookSession(live), {
          stopHookActive: live.stopActive,
          lastAssistantMessage: live.lastReply,
        })
      ).continueWith;
    }
    if (reason && gen === live.runGen) {
      if (live.stopStreak < STOP_HOOK_CAP) {
        live.stopActive = true;
        live.stopStreak += 1;
        live.runner
          .prompt(`Stop hook feedback:\n${reason}`)
          .catch((err: unknown) => this.failRun(live, err));
        return;
      }
      this.emit(live, {
        type: "agent.notice",
        message: `Stop hooks continued the turn ${STOP_HOOK_CAP} times in a row; ending it.`,
      });
    }
    live.stopActive = false;
    live.currentReplyRow = undefined;
    live.tasks.endTurn();
    this.setBusy(live, live, false);
  }

  /** Announces a session's new judge state to its clients. */
  judgeChanged(sessionId: string, state: JudgeState, reason: string): void {
    const live = this.byId.get(sessionId);
    if (live) this.emit(live, { type: "safety.judge", state, reason });
  }

  /** Unpauses the session's judge. Undefined when there is no such session or no judge. */
  resumeJudge(sessionId: string): JudgeState | undefined {
    const judge = this.opts.judge;
    if (!this.byId.has(sessionId) || !judge) return undefined;
    judge.resume(sessionId);
    return judge.state(sessionId);
  }

  /**
   * A user action on the session's task (`/task`, `/override`, `/abandon`). Never reachable
   * from the agent's tools. Throws `TaskStateError` when the task state doesn't allow it.
   */
  taskAction(sessionId: string, action: TaskAction): TaskView | undefined {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    switch (action.kind) {
      case "start":
        // The task row points at the session row. An unused session has no task, so
        // override and abandon throw there and must not store it.
        this.persist(live);
        return live.tasks.start(action.goal);
      case "override":
        return live.tasks.override(action.reason);
      case "abandon":
        return live.tasks.abandon(action.reason);
    }
  }

  /** The models a session can switch to: Pi's catalog, for providers with credentials. */
  async models(): Promise<ModelInfo[]> {
    const first = this.byId.values().next().value as LiveSession | undefined;
    const models = first?.models ?? (await this.opts.models());
    // The tier is read now, so a new login shows its own models.
    const tier = this.planTier() ?? models.planTier;
    const list = await listModels(models.runtime, models.billing, tier);
    return list.filter((m) => !this.refusedPlanModels.has(m.id));
  }

  /** The ChatGPT plan tier of the stored login, read fresh (a new login changes it). */
  private planTier(): string | undefined {
    return readPlanLogin(this.opts.dataDir)?.tier;
  }

  /**
   * The default models, with a ChatGPT plan default this daemon saw refused swapped for the
   * tier's next one.
   */
  private async baseModels(): Promise<ModelChoice> {
    const base = await this.opts.models();
    const name = modelName(base.model);
    if (!this.refusedPlanModels.has(name)) return base;
    const next = planModel(
      base.runtime,
      [base.model.provider],
      "main",
      this.planTier(),
      this.refusedPlanModels,
    );
    const spec = next ? parseModelSpec(next) : undefined;
    const model = spec && base.runtime.getModel(spec.provider, spec.id);
    return model ? { ...base, model } : base;
  }

  /**
   * Switches the session's model (`provider/id`); the next model call uses it, and each call
   * records its own model. Throws `ModelSwitchError` or `SessionBusyError`.
   */
  async setModel(sessionId: string, spec: string): Promise<SessionSnapshot | undefined> {
    const live = this.byId.get(sessionId);
    if (!live) return undefined;
    if (live.busy) throw new SessionBusyError();
    const parsed = parseModelSpec(spec);
    const model = parsed && live.models.runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new ModelSwitchError(`unknown model ${spec.trim() || "(empty)"}`);
    live.inFlight += 1;
    try {
      await live.runner.setModel(model);
    } catch (err) {
      throw new ModelSwitchError(
        explainModelError((err as Error).message, this.opts.dataDir, model.provider),
      );
    } finally {
      live.inFlight -= 1;
    }
    // An unsaved session stores its model when its row is written.
    if (!live.unsaved) this.store.setModel(this.ids(live), live.runner.model);
    const billing = billingKind(live.models, live.runner.model);
    this.emit(live, {
      type: "agent.model",
      model: live.runner.model,
      ...(billing ? { billing } : {}),
    });
    return this.snapshotOf(live);
  }

  /**
   * The ChatGPT plan refused the session's model ("not supported when using Codex with a
   * ChatGPT account"): switch to the plan tier's default and say so (ADR 0024).
   */
  private async fallBackToPlanDefault(live: LiveSession): Promise<void> {
    const current = live.runner.model;
    const from = parseModelSpec(current);
    if (!from) return;
    // Remembered for the daemon's life: never offered or picked again, so no ping-pong.
    this.refusedPlanModels.add(current);
    const target = planModel(
      live.models.runtime,
      [from.provider],
      "main",
      this.planTier(),
      this.refusedPlanModels,
    );
    const to = target ? parseModelSpec(target) : undefined;
    const model = to && live.models.runtime.getModel(to.provider, to.id);
    if (!to || !model) {
      this.emit(live, {
        type: "agent.notice",
        message: `${from.id} isn't on the ChatGPT plan, and no other plan model is left to try. Pick one with /model.`,
      });
      return;
    }
    if (live.busy) return;
    await live.runner.setModel(model);
    if (!live.unsaved) this.store.setModel(this.ids(live), live.runner.model);
    const billing = billingKind(live.models, live.runner.model);
    this.emit(live, {
      type: "agent.model",
      model: live.runner.model,
      ...(billing ? { billing } : {}),
    });
    this.emit(live, {
      type: "agent.notice",
      message: `${from.id} isn't on the ChatGPT plan; using ${to.id}. Send the prompt again.`,
    });
  }

  /** Stops the main agent and every subagent it started (queued ones never start). */
  async abort(sessionId: string): Promise<boolean> {
    const live = this.byId.get(sessionId);
    if (!live) return false;
    // Pi waits for a pending tool_call handler, so answer the approvals first.
    live.runGen += 1;
    this.cancelApprovals(live);
    await Promise.all([
      live.runner.abort(),
      ...[...live.subagents.values()].map((sub) => this.stopSubagent(sub)),
    ]);
    return true;
  }

  // ---- session commands (ADR 0021) ----------------------------------------------------------

  /** The live session, or a 404 `SessionCommandError`. */
  private live(sessionId: string): LiveSession {
    const live = this.byId.get(sessionId);
    if (!live) throw new SessionCommandError("no such session", 404);
    return live;
  }

  private assertIdle(live: LiveSession): void {
    if (live.busy || live.compacting || live.replacing) throw new SessionBusyError();
  }

  /**
   * Starts `plan`'s session in `live`'s cwd and ends `live`: its subagents stop, its approvals
   * are denied, its row ends. Clients attached to it get `session.replaced`.
   */
  private async replace(
    live: LiveSession,
    plan: Exclude<StartPlan, { kind: "fresh" }>,
  ): Promise<LiveSession> {
    this.assertIdle(live);
    live.replacing = true;
    let next: LiveSession;
    try {
      const start = this.create(live.cwd, plan);
      next = await (plan.kind === "resume" ? this.starting(plan.stored.sessionId, start) : start);
    } catch (err) {
      live.replacing = false;
      throw err;
    }
    this.byCwd.set(live.cwd, Promise.resolve(next));
    this.emit(live, { type: "session.replaced", newSessionId: next.id, reason: plan.kind });
    await this.end(live);
    // Ending the old row touched it last; the new one is the cwd's current session.
    if (!next.unsaved) this.store.makeLatest(next.id, next.cwd);
    return next;
  }

  /** `/resume` of a session that is live already: `live` ends and its clients follow. */
  private async handOver(live: LiveSession, target: LiveSession): Promise<LiveSession> {
    this.assertIdle(live);
    live.replacing = true;
    this.byCwd.set(live.cwd, Promise.resolve(target));
    this.emit(live, { type: "session.replaced", newSessionId: target.id, reason: "resume" });
    await this.end(live);
    if (!target.unsaved) this.store.makeLatest(target.id, target.cwd);
    return target;
  }

  private async end(live: LiveSession): Promise<void> {
    live.runGen += 1;
    this.cancelApprovals(live);
    await Promise.all([...live.subagents.values()].map((sub) => this.stopSubagent(sub)));
    this.byId.delete(live.id);
    void live.runner.dispose();
    if (!live.unsaved) this.store.endSession({ sessionId: live.id, agentId: live.agentId });
    this.opts.safetyModes?.setSessionMode(live.id, undefined);
  }

  /** `/new`, `/clear`: a fresh session in the same cwd. */
  async newSession(sessionId: string): Promise<SessionSnapshot> {
    const live = this.live(sessionId);
    return this.snapshotOf(await this.replace(live, { kind: "new", from: live }));
  }

  /** `/resume`: the cwd's sessions, the most recently active first. */
  async listSessions(cwd: string, currentId?: string): Promise<SessionListItem[]> {
    // `current`: the asking client's session; without one, a live session of the cwd.
    const current =
      currentId ?? [...this.byId.values()].find((l) => l.cwd === cwd && !l.replacing)?.id;
    const files = new Set(
      (await SessionManager.list(cwd, this.sessionDir).catch(() => [])).map((s) => s.id),
    );
    return this.store.listSessions(cwd).map((r) => ({
      id: r.id,
      ...(r.name ? { name: r.name } : {}),
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
      messageCount: r.messageCount,
      costMicros: r.costMicros,
      ...(r.firstPrompt ? { firstPrompt: r.firstPrompt } : {}),
      current: r.id === current,
      resumable: r.messageCount === 0 || (r.piSessionId !== null && files.has(r.piSessionId)),
    }));
  }

  /** `/resume <id>`: switches the cwd's live session to a stored one of the same cwd. */
  async resume(sessionId: string, targetId: string): Promise<SessionSnapshot> {
    const live = this.live(sessionId);
    if (targetId === live.id) return this.snapshotOf(live);
    const stored = this.store.session(targetId);
    if (!stored) throw new SessionCommandError("no such session to resume", 404);
    if (stored.cwd !== live.cwd) {
      throw new SessionCommandError("that session belongs to another folder", 400);
    }
    // Live in another window (or waking): switch to it rather than start a second agent.
    // (No await before the replacement registers its start, so no wake slips in between.)
    const waking = this.waking.get(targetId);
    const awake =
      this.byId.get(targetId) ?? (waking ? await waking.catch(() => undefined) : undefined);
    if (awake) return this.snapshotOf(await this.handOver(live, awake));
    if (waking) {
      // That wake failed; start over, so the checks below see the state now.
      return this.resume(sessionId, targetId);
    }
    const file = SessionManager.findById(live.cwd, stored.piSessionId, this.sessionDir);
    // A session with no message (one holding a task moved by `/new`) never had a Pi file.
    if (!file && this.store.hasMessages(targetId)) {
      throw new SessionCommandError("Pi's file for that session is gone", 409);
    }
    return this.snapshotOf(
      await this.replace(live, { kind: "resume", stored, ...(file ? { file } : {}) }),
    );
  }

  /**
   * `/fork <message>`: a new session holding the history before one of the user's messages
   * (Pi's fork). Returns the new snapshot and the message's text, for the input box.
   */
  async fork(
    sessionId: string,
    messageId: string,
  ): Promise<{ snapshot: SessionSnapshot; text: string }> {
    const live = this.live(sessionId);
    this.assertIdle(live);
    const msg = this.store.mainMessage({ sessionId: live.id, agentId: live.agentId }, messageId);
    if (msg?.role !== "user") {
      throw new SessionCommandError("messageId must be one of this session's user messages", 400);
    }
    const branch = msg.externalId ? live.runner.forkPoint(msg.externalId) : undefined;
    if (!branch) throw new SessionCommandError("that message cannot be forked from", 400);
    const next = await this.replace(live, {
      kind: "fork",
      from: live,
      branch,
      beforeMessageId: messageId,
    });
    return { snapshot: this.snapshotOf(next), text: msg.text };
  }

  /** `/compact [instructions]`: Pi's manual compaction. Its progress streams as events. */
  async compact(sessionId: string, instructions?: string): Promise<CompactionOutcome> {
    const live = this.live(sessionId);
    this.assertIdle(live);
    live.compacting = true;
    let out: CompactionOutcome;
    try {
      out = await live.runner.compact(instructions);
      // Claude Code runs SessionStart hooks after a compaction; their context goes with the
      // next prompt.
      await this.sessionStartHooks(live, "compact", live.runner.model);
    } catch (err) {
      throw new SessionCommandError((err as Error).message, 409);
    } finally {
      live.compacting = false;
    }
    return out;
  }

  /** `/session`, `/status`. */
  status(sessionId: string): SessionStatus {
    const live = this.live(sessionId);
    const usage = this.store.sessionUsage(live.id);
    const info = this.info(live);
    const branch = gitBranch(live.cwd);
    const context = live.runner.contextUsage();
    const task = live.tasks.view();
    const file = live.runner.sessionFile;
    const stats = live.runner.stats();
    return {
      sessionId: live.id,
      ...(live.sessionName ? { name: live.sessionName } : {}),
      cwd: live.cwd,
      ...(branch ? { branch } : {}),
      model: live.runner.model,
      ...(info.billing ? { billing: info.billing } : {}),
      thinkingLevel: live.runner.thinkingLevel,
      busy: live.busy,
      ...(context ? { context } : {}),
      tokens: usage.tokens,
      costMicros: usage.costMicros,
      planCalls: usage.planCalls,
      messages: stats,
      ...(task ? { task } : {}),
      ...(info.mode ? { mode: info.mode, modeSource: live.ownMode ? "session" : "config" } : {}),
      ...(info.judge ? { judge: info.judge } : {}),
      ...(file ? { sessionFile: file } : {}),
    } as SessionStatus;
  }

  thinking(sessionId: string): { level: ThinkingLevel; levels: ThinkingLevel[] } {
    const live = this.live(sessionId);
    return { level: live.runner.thinkingLevel, levels: live.runner.thinkingLevels() };
  }

  /** `/thinking <level>`: one of the levels the model supports (Pi's list). */
  setThinking(sessionId: string, level: string): { level: ThinkingLevel; levels: ThinkingLevel[] } {
    const live = this.live(sessionId);
    if (live.replacing || live.compacting) throw new SessionBusyError();
    const levels = live.runner.thinkingLevels();
    if (!(levels as string[]).includes(level)) {
      throw new SessionCommandError(`level must be one of ${levels.join(", ")}`, 400);
    }
    live.runner.setThinkingLevel(level as ThinkingLevel);
    return this.thinking(sessionId);
  }

  /** `/name <name>`: kept on the session row and in Pi's session file. */
  rename(sessionId: string, name: string): SessionSnapshot {
    const live = this.live(sessionId);
    if (live.replacing) throw new SessionBusyError();
    this.persist(live);
    live.sessionName = name;
    live.runner.setName(name);
    this.store.setSessionSettings(live.id, { name });
    this.emit(live, { type: "session.name", name });
    return this.snapshotOf(live);
  }

  /**
   * `/export [path]`: Pi's HTML or JSONL export. Without a path it goes under
   * `<dataDir>/exports`; a relative path is in the session's cwd. Returns the path written.
   */
  async exportSession(
    sessionId: string,
    format: "html" | "jsonl",
    opts: { path?: string; overwrite?: boolean } = {},
  ): Promise<string> {
    const live = this.live(sessionId);
    const dir = join(this.opts.dataDir, "exports");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = opts.path
      ? resolve(live.cwd, opts.path)
      : join(dir, `${live.id}-${stamp}.${format}`);
    if (!isDirectory(dirname(target))) {
      throw new SessionCommandError(`no folder ${dirname(target)}`, 400);
    }
    const existing = lstatOrUndefined(target);
    // Never through a symlink, dangling or not: it would write wherever the link points.
    if (existing?.isSymbolicLink()) throw new SessionCommandError(`${target} is a symlink`, 400);
    if (existing && !opts.overwrite) {
      throw new SessionCommandError(`${target} exists; send overwrite: true to replace it`, 409);
    }
    // Pi writes into hamness's own folder; the copy to the target refuses links (O_NOFOLLOW)
    // and, without overwrite, any file that appeared meanwhile (O_EXCL).
    const scratch = join(dir, `.${newId()}.${format}`);
    let fd: number | undefined;
    try {
      const written =
        format === "html"
          ? await live.runner.exportHtml(scratch)
          : live.runner.exportJsonl(scratch);
      const flags =
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW |
        (opts.overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
      fd = openSync(target, flags, 0o600);
      writeSync(fd, readFileSync(written));
      return target;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new SessionCommandError(`${target} exists`, 409);
      if (code === "ELOOP") throw new SessionCommandError(`${target} is a symlink`, 400);
      throw new SessionCommandError(`could not export: ${(err as Error).message}`, 409);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(scratch, { force: true });
    }
  }

  /** `/copy`: the last assistant message's text. Undefined before the first reply. */
  lastReply(sessionId: string): string | undefined {
    const text = this.live(sessionId).runner.lastAssistantText();
    return text === undefined ? undefined : redactSecrets(text);
  }

  mode(sessionId: string): { mode: SafetyMode; source: "session" | "config" } {
    const live = this.live(sessionId);
    const mode = this.modeOf(live);
    if (!mode) throw new SessionCommandError("this daemon has no safety modes", 409);
    return { mode, source: live.ownMode ? "session" : "config" };
  }

  /** `/mode <ask|auto|yolo>` for this session; `yolo` comes with a warning for a banner. */
  setMode(sessionId: string, mode: SafetyMode): { mode: SafetyMode; source: "session" } {
    const live = this.live(sessionId);
    // During `/new`, `/resume` or `/fork` the setting would go to a session that is ending.
    if (live.replacing) throw new SessionBusyError();
    const modes = this.opts.safetyModes;
    if (!modes) throw new SessionCommandError("this daemon has no safety modes", 409);
    live.ownMode = mode;
    modes.setSessionMode(live.id, mode);
    if (!live.unsaved) this.store.setSessionSettings(live.id, { safetyMode: mode });
    this.emit(live, {
      type: "safety.mode",
      mode,
      ...(mode === "yolo" ? { warning: YOLO_WARNING } : {}),
    });
    return { mode, source: "session" };
  }

  /** The skills and MCP servers the session loaded from Claude Code's setup (ADR 0008). */
  compatInfo(sessionId: string): SessionCompat {
    const live = this.live(sessionId);
    const compat = live.compat;
    const tools = live.runner.mcpTools();
    return {
      skills: (compat?.skills.skills ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        userInvocable: s.userInvocable,
        modelInvocable: !s.disableModelInvocation,
      })),
      mcpServers: (compat?.mcp.servers ?? []).map((m) => ({
        name: m.name,
        scope: m.scope,
        status: m.status,
        ...(m.reason ? { reason: m.reason } : {}),
        ...(m.status === "start" ? { tools: tools[m.name] ?? 0 } : {}),
      })),
    };
  }

  /** Answers a pending approval. False when there is no such approval (unknown or answered). */
  answerApproval(approvalId: string, decision: ApprovalDecision): boolean {
    for (const live of this.byId.values()) {
      const entry = live.approvals.get(approvalId);
      if (entry) {
        entry.settle({ decision, by: "user" });
        return true;
      }
    }
    return false;
  }

  /**
   * Ends every session and subagent: their turns abort and their MCP servers close. Resolves
   * once all runners are disposed, including sessions that were still starting.
   */
  async stop(): Promise<void> {
    this.queue.length = 0;
    const disposing: Array<Promise<void>> = [];
    for (const live of this.byId.values()) {
      this.cancelApprovals(live);
      for (const sub of live.subagents.values()) {
        sub.stopping = true;
        if (sub.agent) disposing.push(sub.agent.runner.dispose());
        if (!FINISHED.has(sub.status)) this.store.setAgentStatus(sub.id, "aborted");
      }
      disposing.push(live.runner.dispose());
    }
    // A session still starting has no byId entry yet: dispose it once it is up.
    // (dispose is idempotent, so the sessions above can show up here again.)
    for (const starting of this.byCwd.values()) {
      disposing.push(starting.then((live) => live.runner.dispose()).catch(() => {}));
    }
    this.byId.clear();
    this.byCwd.clear();
    this.asleep.clear();
    await Promise.all(disposing);
  }

  private get sessionDir(): string {
    return join(this.opts.dataDir, "pi", "sessions");
  }

  private async create(cwd: string, plan: StartPlan = { kind: "fresh" }): Promise<LiveSession> {
    const base = await this.baseModels();
    const sessionDir = this.sessionDir;
    const resume = plan.kind === "resume" ? { ...plan.stored, file: plan.file } : undefined;
    // `/new` and `/fork` keep the session's model, thinking level and mode. A fresh launch
    // takes the default model (ADR 0023); one that slept unsaved wakes with its own settings.
    const from = plan.kind === "new" || plan.kind === "fork" ? plan.from : undefined;
    const carry = plan.kind === "fresh" ? plan.carry : undefined;
    const savedSpec = resume?.model ?? from?.runner.model ?? carry?.model;
    const saved = savedSpec ? parseModelSpec(savedSpec) : undefined;
    const savedModel = saved && base.runtime.getModel(saved.provider, saved.id);
    // A resumed session's stored model that Pi can't call (no key or login) while the default
    // can: switch and say so (a session from before the ChatGPT plan login, ADR 0024). A model
    // live in the session (`/new`, `/fork`) is the user's and is never switched.
    let unusable = false;
    if (savedModel && !from) {
      const available = await base.runtime.getAvailable().catch(() => undefined);
      const has = (m: ModelChoice["model"]) =>
        available?.some((a) => a.provider === m.provider && a.id === m.id) === true;
      unusable = available !== undefined && !has(savedModel) && has(base.model);
    }
    const models: ModelChoice = savedModel && !unusable ? { ...base, model: savedModel } : base;
    const label = base.billing?.(base.model.provider);
    const modelNotice =
      unusable && savedModel
        ? `Switched to ${modelName(base.model)}${label ? ` (${billingLabel(label)})` : ""}: ${modelName(savedModel)} has no key.`
        : undefined;
    const model = `${models.model.provider}/${models.model.id}`;
    const thinkingLevel =
      asThinking(resume?.thinkingLevel) ?? from?.runner.thinkingLevel ?? carry?.thinkingLevel;
    const ownMode = resume
      ? (SAFETY_MODES as readonly string[]).includes(resume.safetyMode ?? "")
        ? (resume.safetyMode as SafetyMode)
        : undefined
      : (from?.ownMode ?? carry?.ownMode);
    const sessionName = resume?.name ?? carry?.name;
    // `live` is filled in before the runner can emit anything: events only follow a prompt.
    let live: LiveSession | undefined;
    const withCompat = this.opts.contextFiles ?? true;
    const compat = withCompat
      ? loadCompat({
          cwd,
          dataDir: this.opts.dataDir,
          claude: this.opts.claude ?? { env: process.env },
        })
      : undefined;
    const ready = (): LiveSession => {
      if (!live) throw new Error("session not ready");
      return live;
    };
    const control: SubagentControl = {
      start: (req) => this.startSubagent(live as LiveSession, req),
      status: (id) => {
        const sub = live?.subagents.get(id);
        return sub && this.report(sub);
      },
      wait: (id, timeoutMs, signal) => {
        const sub = live?.subagents.get(id);
        return sub ? this.waitFor(sub, timeoutMs, signal) : Promise.resolve(undefined);
      },
    };
    const runner = await startAgentRunner({
      cwd,
      agentDir: join(this.opts.dataDir, "pi"),
      sessionDir,
      ...(resume?.file ? { resumeFile: resume.file } : {}),
      ...(plan.kind === "fork" ? { branchFrom: plan.branch } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      models,
      contextFiles: withCompat,
      ...(compat ? { compat } : {}),
      systemPromptAppend: [PROOF_GATE_PROMPT],
      tools: [
        ...taskTools({
          start: (goal) => ready().tasks.start(goal),
          done: (summary) => ready().tasks.done(summary),
          prove: (input, piId, signal) => {
            const l = ready();
            const toolCallId = l.tools.get(piId);
            return l.tasks.prove(input, {
              ...(toolCallId ? { toolCallId } : {}),
              ...(signal ? { signal } : {}),
            });
          },
        }),
        ...subagentTools(control),
      ],
      onEvent: (e) => live && this.onRunnerEvent(live, live, e),
      guard: (call) =>
        live ? this.guard(live, live, call) : Promise.resolve(notReady("session not ready")),
      ...(this.opts.hooks ? { afterTool: (call) => this.postToolHooks(live, call) } : {}),
    });
    const { sessionId, agentId } = resume
      ? { sessionId: resume.sessionId, agentId: resume.agentId }
      : plan.kind === "fresh" && plan.ids
        ? plan.ids
        : { sessionId: newId(), agentId: newId() };
    const startedAt = Date.now();
    // An open explicit task follows `/new` and `/fork` (ADR 0021), and a fork shows the history
    // it continues: both need the session's rows now.
    let stored = !!resume;
    try {
      // All or nothing: a failure leaves the old session with its task (and no new rows).
      this.opts.db.sqlite.transaction(() => {
        if (from && (plan.kind === "fork" || this.store.hasOpenExplicitTask(from.id))) {
          this.store.createSession(cwd, model, runner.piSessionId, {
            ids: { sessionId, agentId },
            startedAt,
          });
          this.store.moveOpenTask(from.id, sessionId);
          if (plan.kind === "fork") {
            this.store.copyTranscript(
              { sessionId: from.id, agentId: from.agentId },
              { sessionId, agentId },
              plan.beforeMessageId,
            );
          }
          stored = true;
        }
        // A task holder that never had a prompt has no Pi file: it starts a fresh one.
        if (resume && !resume.file) this.store.setPiSessionId(sessionId, runner.piSessionId);
        if (plan.kind === "resume") this.store.reopenSession({ sessionId, agentId });
      })();
    } catch (err) {
      void runner.dispose();
      throw err;
    }
    this.opts.safetyModes?.setSessionMode(sessionId, ownMode);
    const tasks = new SessionTasks({
      db: this.opts.db,
      sessionId,
      cwd,
      emit: (e) => live && this.emit(live, e),
      // A `prove` command re-run is checked like a bash call, approvals included.
      safety: (call) => {
        const target = ready();
        return this.safety(call, {
          cwd,
          askUser: (req) => this.requestApproval(target, req),
        });
      },
      gh: this.opts.gh ?? runGh,
      fetch: this.opts.fetch ?? ((input, init) => fetch(input, init)),
      allowPrivateUrls: () => {
        try {
          return loadProofConfig(this.opts.dataDir, cwd).allowPrivateUrls;
        } catch {
          return false;
        }
      },
    });
    live = {
      id: sessionId,
      agentId,
      cwd,
      runner,
      models: base,
      seq: this.lastSeqs.get(sessionId) ?? 0,
      busy: false,
      replies: new Map(),
      currentReplyRow: undefined,
      tools: new Map(),
      denied: new Map(),
      approvals: new Map(),
      subagents: new Map(),
      tasks,
      ...(compat ? { compat } : {}),
      ready: Promise.resolve(),
      lastReply: "",
      stopActive: false,
      stopStreak: 0,
      runGen: 0,
      compacting: false,
      replacing: false,
      inFlight: 0,
      ...(sessionName ? { sessionName } : {}),
      ...(ownMode ? { ownMode } : {}),
      ...(stored ? {} : { unsaved: { piSessionId: runner.piSessionId, startedAt } }),
    };
    if (stored && !resume) this.saveSettings(live);
    if (modelNotice) {
      live.modelNotice = modelNotice;
      if (!live.unsaved) this.store.setModel(this.ids(live), live.runner.model);
    }
    const started = live;
    started.inFlight += 1;
    started.ready = this.sessionStartHooks(
      started,
      resume ? "resume" : plan.kind === "new" ? "clear" : "startup",
      model,
    ).finally(() => {
      started.inFlight -= 1;
    });
    this.byId.set(sessionId, live);
    return live;
  }

  /** Every tool call of any agent of the session passes the same safety check, in its cwd. */
  private async guard(
    live: LiveSession,
    agent: AgentState,
    call: Parameters<ToolGuard>[0],
  ): Promise<ToolVerdict> {
    const toolCallId = this.toolRow(live, agent, call.toolCallId, call.tool, call.args);
    try {
      return await this.safety(
        {
          sessionId: live.id,
          toolCallId,
          tool: call.tool,
          args: call.args,
          cwd: agent.cwd,
          ...(agent.runner.sessionFile ? { transcriptPath: agent.runner.sessionFile } : {}),
        },
        {
          cwd: agent.cwd,
          askUser: (req) =>
            this.requestApproval(
              live,
              req,
              agent === live ? undefined : { id: agent.agentId, name: agent.name },
            ),
        },
      );
    } catch (err) {
      return { allow: false, reason: `safety check failed: ${(err as Error).message}` };
    }
  }

  // ---- subagents (ADR 0015) -----------------------------------------------------------------

  private startSubagent(live: LiveSession, req: SubagentStart): SubagentReport {
    const name = req.name.trim();
    if (!name) throw new Error("a subagent needs a name");
    if (!req.prompt.trim()) throw new Error("a subagent needs a prompt");
    const model = req.model ? this.resolveModel(live, req.model) : live.runner.model;
    const taskId = live.tasks.attributionId();
    const id = this.store.createSubagent({
      sessionId: live.id,
      parentAgentId: live.agentId,
      ...(taskId ? { taskId } : {}),
      name,
      model,
    });
    const sub: Subagent = {
      id,
      name,
      prompt: req.prompt,
      model,
      wantsWorktree: req.worktree === true,
      session: live,
      ...(taskId ? { taskId } : {}),
      status: "queued",
      stopping: false,
      waiters: new Set(),
    };
    live.subagents.set(id, sub);
    this.emit(live, { type: "agent.start", name, parentAgentId: live.agentId, model }, id);
    this.queue.push(sub);
    this.pump();
    return this.report(sub);
  }

  /** `provider/id` of a model the session's runtime knows, or a thrown error. */
  private resolveModel(live: LiveSession, spec: string): string {
    const parsed = parseModelSpec(spec);
    const model = parsed && live.models.runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error(`unknown model ${spec.trim() || "(empty)"}`);
    return `${model.provider}/${model.id}`;
  }

  private pump(): void {
    const max = this.opts.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
    while (this.running < max && this.queue.length > 0) {
      const sub = this.queue.shift() as Subagent;
      this.running += 1;
      this.runSubagent(sub)
        .catch((err: unknown) => {
          sub.error ??= (err as Error).message ?? String(err);
        })
        .finally(() => {
          this.running -= 1;
          this.finishSubagent(sub);
          this.pump();
        });
    }
  }

  private async runSubagent(sub: Subagent): Promise<void> {
    if (sub.stopping) return;
    const live = sub.session;
    sub.status = "running";
    this.store.setAgentStatus(sub.id, "running");
    let cwd = live.cwd;
    if (sub.wantsWorktree) {
      const wt = await createWorktree(live.cwd, sub.name, sub.id);
      sub.worktree = wt.path;
      sub.branch = wt.branch;
      this.store.setAgentWorktree(sub.id, wt.path);
      cwd = wt.path;
    }
    if (sub.stopping) return;
    const parsed = parseModelSpec(sub.model);
    const model = parsed && live.models.runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error(`unknown model ${sub.model}`);
    let agent: AgentState | undefined;
    const runner = await startAgentRunner({
      cwd,
      agentDir: join(this.opts.dataDir, "pi"),
      models: { ...live.models, model },
      contextFiles: this.opts.contextFiles ?? true,
      ...(live.compat ? { compat: live.compat } : {}),
      onEvent: (e) => agent && this.onRunnerEvent(live, agent, e),
      guard: (call) =>
        agent ? this.guard(live, agent, call) : Promise.resolve(notReady("agent not ready")),
    });
    agent = {
      agentId: sub.id,
      cwd,
      runner,
      busy: false,
      replies: new Map(),
      currentReplyRow: undefined,
      tools: new Map(),
      denied: new Map(),
      name: sub.name,
      ...(sub.taskId ? { taskId: sub.taskId } : {}),
    };
    sub.agent = agent;
    if (sub.stopping) return;
    this.setBusy(live, agent, true);
    await runner.prompt(sub.prompt);
    if (agent.lastError) sub.error = agent.lastError;
    else sub.result = agent.lastText ?? "";
  }

  /** Ends a subagent's run: its row, its rail row, then its result to the parent. */
  private finishSubagent(sub: Subagent): void {
    if (FINISHED.has(sub.status)) return;
    const live = sub.session;
    sub.status = sub.stopping ? "aborted" : sub.error !== undefined ? "error" : "done";
    if (sub.status === "aborted") sub.error ??= "stopped";
    this.store.setAgentStatus(sub.id, sub.status);
    void sub.agent?.runner.dispose();
    if (sub.status === "aborted") this.emit(live, { type: "agent.stopped" }, sub.id);
    else if (sub.status !== "done") {
      this.emit(live, { type: "agent.error", message: sub.error ?? sub.status }, sub.id);
    }
    if (sub.agent) this.setBusy(live, sub.agent, false);
    if (!this.byId.has(live.id)) return;
    if (sub.waiters.size > 0) {
      for (const wake of sub.waiters) wake();
    } else if (sub.status !== "aborted") {
      live.runner.notify(noticeText(this.report(sub))).catch(() => {});
    }
  }

  private async stopSubagent(sub: Subagent): Promise<void> {
    if (FINISHED.has(sub.status)) return;
    sub.stopping = true;
    const queued = this.queue.indexOf(sub);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.finishSubagent(sub);
      return;
    }
    await sub.agent?.runner.abort();
  }

  private waitFor(sub: Subagent, timeoutMs: number, signal?: AbortSignal): Promise<SubagentReport> {
    if (FINISHED.has(sub.status) || signal?.aborted) return Promise.resolve(this.report(sub));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        sub.waiters.delete(done);
        resolve(this.report(sub));
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      sub.waiters.add(done);
    });
  }

  private report(sub: Subagent): SubagentReport {
    return {
      id: sub.id,
      name: sub.name,
      status: sub.status,
      model: sub.model,
      ...(sub.status === "done" ? { result: sub.result ?? "" } : {}),
      ...(sub.error !== undefined && sub.status !== "done" ? { error: sub.error } : {}),
      ...(sub.worktree ? { worktree: sub.worktree } : {}),
      ...(sub.branch ? { branch: sub.branch } : {}),
    };
  }

  private async sessionStartHooks(
    live: LiveSession,
    source: SessionStartSource,
    model: string,
  ): Promise<void> {
    const hooks = this.opts.hooks;
    if (!hooks) return;
    try {
      const started = await hooks.sessionStart(this.hookSession(live), { source, model });
      if (started.context) live.startContext = started.context;
      if (started.notice) live.startNotice = started.notice;
    } catch {
      // A hook problem never keeps the session from starting.
    }
  }

  /** PostToolUse hooks; their feedback goes next to the tool's result. */
  private async postToolHooks(
    live: LiveSession | undefined,
    call: {
      toolCallId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      isError: boolean;
    },
  ): Promise<string | undefined> {
    const hooks = this.opts.hooks;
    if (!hooks || !live || call.isError) return undefined;
    const r = await hooks.postToolUse(this.hookSession(live), {
      tool: call.tool,
      args: call.args,
      toolUseId: live.tools.get(call.toolCallId) ?? call.toolCallId,
      output: call.output,
    });
    return r.context && `PostToolUse hook feedback:\n${r.context}`;
  }

  private snapshotOf(live: LiveSession): SessionSnapshot {
    const streaming = new Map(
      [...live.replies.values()].filter((r) => !r.done).map((r) => [r.rowId, r.text]),
    );
    const items = this.store.transcript(live.id, live.agentId).map((item): TranscriptItem => {
      if (item.kind !== "message") return item;
      const partial = streaming.get(item.id);
      return partial === undefined
        ? item
        : { ...item, text: redactSecrets(partial), streaming: true };
    });
    const context = live.runner.contextUsage();
    const task = live.tasks.view();
    const checks = live.unsaved ? [] : live.tasks.checks();
    return {
      session: this.info(live),
      seq: live.seq,
      items,
      agents: live.unsaved
        ? [{ id: live.agentId, kind: "main", tokens: 0, costMicros: 0 }]
        : this.store.agentTotals(live.id),
      ...(task ? { task } : {}),
      ...(checks.length ? { checks } : {}),
      ...(context ? { context } : {}),
      approvals: [...live.approvals.values()].map((e) => e.approval),
    };
  }

  private info(live: LiveSession): SessionInfo {
    const mode = this.modeOf(live);
    // Yolo skips the judge, but its state still shows (it is what `/mode auto` brings back).
    const judge = mode === "auto" || mode === "yolo" ? this.opts.judge?.state(live.id) : undefined;
    const billing = billingKind(live.models, live.runner.model);
    return {
      id: live.id,
      cwd: live.cwd,
      model: live.runner.model,
      ...(billing ? { billing } : {}),
      busy: live.busy,
      mainAgentId: live.agentId,
      ...(mode ? { mode } : {}),
      ...(judge ? { judge } : {}),
      ...(live.sessionName ? { name: live.sessionName } : {}),
      thinkingLevel: live.runner.thinkingLevel,
    };
  }

  private modeOf(live: LiveSession): SafetyMode | undefined {
    return this.opts.safetyModes?.modeFor(live.cwd, live.id);
  }

  /** Publishes an approval request and waits for an answer, the timeout or an abort. */
  private requestApproval(
    live: LiveSession,
    req: ApprovalRequest,
    subagent?: { id: string; name?: string | undefined },
  ): Promise<ApprovalAnswer> {
    const agentId = subagent?.id;
    return new Promise((resolve) => {
      const approval: PendingApproval = {
        id: newId(),
        toolCallId: req.toolCallId,
        tool: req.tool,
        args: req.args,
        reason: req.reason,
        suggestions: req.suggestions,
        expiresAt: Date.now() + req.timeoutMs,
        ...(subagent ? { agentId: subagent.id } : {}),
        ...(subagent?.name ? { agentName: subagent.name } : {}),
      };
      const timer = setTimeout(
        () => settle({ decision: "deny", by: "timeout" }),
        Math.min(req.timeoutMs, 2_147_483_647),
      );
      const settle = (answer: ApprovalAnswer) => {
        if (!live.approvals.delete(approval.id)) return;
        clearTimeout(timer);
        this.emit(
          live,
          {
            type: "safety.approval.resolved",
            approvalId: approval.id,
            decision: answer.decision === "deny" ? "deny" : "allow",
            by: answer.by,
          },
          agentId,
        );
        resolve(answer);
      };
      live.approvals.set(approval.id, { approval, settle });
      this.emit(live, { type: "safety.approval.request", approval }, agentId);
    });
  }

  private cancelApprovals(live: LiveSession): void {
    for (const entry of [...live.approvals.values()])
      entry.settle({ decision: "deny", by: "abort" });
  }

  /**
   * Row ids for what an agent stores now: the main agent's rows count toward the current task,
   * a subagent's toward the parent's task when it was started (ADR 0015).
   */
  private ids(live: LiveSession, agent: AgentState = live): RowIds {
    const taskId = agent === live ? live.tasks.attributionId() : agent.taskId;
    return { sessionId: live.id, agentId: agent.agentId, taskId };
  }

  /** Publishes a session event about `agentId` (default: the main agent). */
  private emit(live: LiveSession, body: EventBody, agentId: string = live.agentId): void {
    live.seq += 1;
    this.lastSeqs.set(live.id, live.seq);
    this.opts.publish({
      ...body,
      sessionId: live.id,
      agentId,
      seq: live.seq,
    } as AgentEvent);
  }

  private setBusy(live: LiveSession, agent: AgentState, busy: boolean): void {
    if (agent.busy === busy) return;
    agent.busy = busy;
    if (agent === live) {
      if (busy) live.runStartedAt = Date.now();
      else if (live.runStartedAt !== undefined) {
        this.store.endRun(live.id, Date.now() - live.runStartedAt);
        live.runStartedAt = undefined;
      }
    }
    this.emit(live, { type: "agent.status", busy }, agent.agentId);
  }

  /** The `tool_calls` row for a Pi tool call, created (and announced) on first sight. */
  private toolRow(
    live: LiveSession,
    agent: AgentState,
    piId: string,
    tool: string,
    rawArgs: Record<string, unknown>,
  ): string {
    const existing = agent.tools.get(piId);
    if (existing) return existing;
    const args = redactArgs(rawArgs);
    const messageId = agent.currentReplyRow;
    const id = this.store.addToolCall(this.ids(live, agent), {
      messageId,
      tool,
      argsJson: JSON.stringify(args),
    });
    agent.tools.set(piId, id);
    this.emit(
      live,
      {
        type: "agent.tool.start",
        toolCallId: id,
        ...(messageId ? { messageId } : {}),
        tool,
        args,
      },
      agent.agentId,
    );
    return id;
  }

  private onRunnerEvent(live: LiveSession, agent: AgentState, e: RunnerEvent): void {
    const emit = (body: EventBody) => this.emit(live, body, agent.agentId);
    switch (e.type) {
      case "assistant.start": {
        const rowId = this.store.addMessage(this.ids(live, agent), "assistant", null);
        agent.replies.set(e.key, { rowId, text: "", done: false, redact: new ReplyRedactor() });
        agent.currentReplyRow = rowId;
        emit({ type: "agent.message.start", messageId: rowId, role: "assistant" });
        return;
      }
      case "assistant.delta": {
        const reply = agent.replies.get(e.key);
        if (!reply) return;
        reply.text += e.text;
        // Redacted as it streams, a short tail held back so a split secret is still caught.
        const safe = reply.redact.push(e.text);
        if (safe) emit({ type: "agent.message.delta", messageId: reply.rowId, text: safe });
        return;
      }
      case "assistant.end": {
        const reply = agent.replies.get(e.key);
        if (!reply) return;
        reply.text = e.text;
        reply.done = true;
        agent.lastText = e.text;
        // Pi ends a reply cut short by `abort()` as `aborted`, with an error message. A user
        // stop is not a failure (`agent.stopped` says it); real errors stay errors.
        // A reply with no text, no tool call and no error is a failure too (seen when a ChatGPT
        // plan tier doesn't serve the model): say so rather than show nothing.
        const silent = !e.error && e.stopReason === "stop" && !e.text.trim();
        const error = silent
          ? SILENT_REPLY
          : e.error && e.stopReason !== "aborted"
            ? explainModelError(e.error, this.opts.dataDir, e.provider)
            : undefined;
        if (error) agent.lastError = error;
        else delete agent.lastError;
        const plan = isSubscriptionBilling(live.models.billing?.(e.provider));
        const onPlan = live.models.billing?.(e.provider)?.kind === "plan";
        // The ChatGPT plan refused this model (or answered with nothing): switch to the
        // tier's next model once the run ends.
        if (
          agent === live &&
          ((e.error && PLAN_UNSUPPORTED_ERROR.test(e.error)) || (silent && onPlan))
        ) {
          live.planFallback = true;
        }
        if (agent === live) live.lastReply = e.text;
        // Stored and sent redacted alike: a reopened session shows what the live one ended on.
        // Only unmistakable secrets: a reply that explains `API_KEY=…` reads as written.
        const shown = redactSecrets(e.text);
        const tail = reply.redact.flush();
        if (tail) emit({ type: "agent.message.delta", messageId: reply.rowId, text: tail });
        this.store.setMessageContent(reply.rowId, shown);
        // A subscription call costs $0: tokens are kept, no API price (ADR 0024). Billing is
        // read per call from Pi's auth state, so a login or logout counts at once.
        const priced = plan ? 0 : costMicros(e.model, e.usage);
        const cost = priced ?? Math.round(e.piCostUsd * 1_000_000);
        const modelCallId = this.store.addModelCall(this.ids(live, agent), {
          messageId: reply.rowId,
          provider: e.provider,
          model: e.model,
          usage: e.usage,
          costMicros: cost,
          ...(plan ? { billing: "plan" as const } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        });
        emit({
          type: "agent.message.end",
          messageId: reply.rowId,
          role: "assistant",
          text: shown,
          ...(error ? { error } : {}),
        });
        emit({
          type: "agent.usage",
          modelCallId,
          messageId: reply.rowId,
          provider: e.provider,
          model: e.model,
          inputTokens: e.usage.input,
          outputTokens: e.usage.output,
          cacheReadTokens: e.usage.cacheRead,
          cacheWriteTokens: e.usage.cacheWrite,
          costMicros: cost,
          priced: priced !== undefined,
          ...(plan ? { billing: "plan" as const } : {}),
        });
        // Finished replies no longer need their buffer; the row has the text.
        agent.replies.delete(e.key);
        return;
      }
      case "tool.start":
        if (agent === live) live.stopStreak = 0;
        this.toolRow(live, agent, e.toolCallId, e.tool, e.args);
        return;
      case "tool.denied":
        agent.denied.set(e.toolCallId, e.reason);
        return;
      case "tool.end": {
        const id = agent.tools.get(e.toolCallId);
        if (!id) return;
        const reason = agent.denied.get(e.toolCallId);
        const end = {
          status:
            reason !== undefined
              ? ("denied" as const)
              : e.isError
                ? ("error" as const)
                : ("ok" as const),
          summary: redactText(reason ?? e.summary),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        };
        this.store.finishToolCall(id, end);
        agent.tools.delete(e.toolCallId);
        agent.denied.delete(e.toolCallId);
        emit({ type: "agent.tool.end", toolCallId: id, ...end });
        return;
      }
      case "context": {
        const { type: _, ...fill } = e;
        if (agent !== live) return;
        emit({ type: "agent.context", ...fill });
        return;
      }
      case "user.entry":
        if (agent === live && live.pendingUserRow) {
          this.store.setMessageExternalId(live.pendingUserRow, e.entryId);
          live.pendingUserRow = undefined;
        }
        return;
      case "thinking":
        if (agent !== live) return;
        if (!live.unsaved) this.store.setSessionSettings(live.id, { thinkingLevel: e.level });
        emit({ type: "agent.thinking", level: e.level });
        return;
      case "compaction.start":
        if (agent === live) emit({ type: "agent.compaction.start", reason: e.reason });
        return;
      case "compaction.end": {
        // The summary is a model call: its spend counts (toward the task, if one is open).
        if (e.usage && e.provider && e.model) {
          this.persist(live);
          const plan = isSubscriptionBilling(live.models.billing?.(e.provider));
          const priced = plan ? 0 : costMicros(e.model, e.usage);
          const ids =
            agent === live
              ? { sessionId: live.id, agentId: live.agentId, taskId: live.tasks.openTaskId() }
              : this.ids(live, agent);
          this.store.addModelCall(ids, {
            provider: e.provider,
            model: e.model,
            usage: e.usage,
            costMicros: priced ?? Math.round((e.piCostUsd ?? 0) * 1_000_000),
            ...(plan ? { billing: "plan" as const } : {}),
          });
        }
        if (agent !== live) return;
        emit({
          type: "agent.compaction.end",
          reason: e.reason,
          aborted: e.aborted,
          ...(e.tokensBefore !== undefined ? { tokensBefore: e.tokensBefore } : {}),
          ...(e.tokensAfter !== undefined ? { tokensAfter: e.tokensAfter } : {}),
          ...(e.error ? { error: e.error } : {}),
        });
        return;
      }
      case "run.settled":
        agent.currentReplyRow = undefined;
        // A call Pi never ended (a tool threw past it) must not stay running: the proof gate
        // reads a running call as a file change happening now.
        for (const [piId, id] of agent.tools) {
          const end = { status: "error" as const, summary: "ended without a result" };
          this.store.finishToolCall(id, end);
          agent.tools.delete(piId);
          agent.denied.delete(piId);
          emit({ type: "agent.tool.end", toolCallId: id, ...end });
        }
        // A subagent's last status waits for its result (`finishSubagent`); no Stop hooks.
        if (agent !== live) return;
        if (e.aborted) emit({ type: "agent.stopped" });
        this.afterRun(live, e.aborted)
          .catch(() => {
            live.currentReplyRow = undefined;
            live.tasks.endTurn();
            this.setBusy(live, live, false);
          })
          .then(() => {
            if (!live.planFallback) return;
            live.planFallback = false;
            return this.fallBackToPlanDefault(live);
          })
          .catch(() => {});
        return;
    }
  }
}

const notReady = (reason: string): ToolVerdict => ({ allow: false, reason });

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
