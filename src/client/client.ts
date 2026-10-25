import { spawn } from "node:child_process";
import { openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "../agent/models.ts";
import type { CompactionOutcome } from "../agent/runner.ts";
import type {
  Launch,
  SessionCompat,
  SessionListItem,
  SessionStatus,
} from "../agent/session-hub.ts";
import type { Env } from "../config/paths.ts";
import { dataPaths, ensureDataDir } from "../config/paths.ts";
import { DAEMON_FEATURES, type DaemonStatus, getStatus } from "../daemon/status.ts";
import type {
  ApprovalDecision,
  HamnessEvent,
  JudgeState,
  SafetyMode,
  SessionSnapshot,
  ThinkingLevel,
} from "../events/types.ts";
import type { TaskAction, TaskView } from "../tasks/types.ts";
import { VERSION } from "../version.ts";

/** What a client (TUI, later the dashboard) needs from the daemon. */
export interface DaemonClient {
  /**
   * The client's session in `cwd` (ADR 0023): `new` a fresh one, `continue` (the default) the
   * cwd's latest, `session` that one (`--resume <id>`, and coming back to the session it had).
   */
  attach(cwd: string, how?: Launch): Promise<SessionSnapshot>;
  prompt(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** The models a session can switch to. */
  models(): Promise<ModelInfo[]>;
  /** Switches the session to `provider/id`; rejects with the daemon's reason. */
  setModel(sessionId: string, model: string): Promise<SessionSnapshot>;
  /** Answers a pending tool approval (`safety.approval.request`). */
  answerApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Unpauses the session's judge (`/judge resume`); resolves with its state now. */
  resumeJudge(sessionId: string): Promise<JudgeState>;
  /** `/task`, `/override`, `/abandon`: the user's task actions. Rejects with the daemon's reason. */
  task(sessionId: string, action: TaskAction): Promise<TaskView>;
  /** Opens the event stream; returns a function that closes it. */
  subscribe(onEvent: (event: HamnessEvent) => void): () => void;
  /** Resolves once the event stream is open (after `subscribe`). */
  readonly ready: Promise<void>;
}

/** The slash commands' daemon calls (ADR 0021). Each rejects with the daemon's reason. */
export interface SessionCommands {
  /** `/new`, `/clear`: the new session's snapshot. */
  newSession(sessionId: string): Promise<SessionSnapshot>;
  /** The cwd's sessions, the most recently active first (`/resume`); `current` is the caller's. */
  listSessions(cwd: string, current?: string): Promise<SessionListItem[]>;
  resume(sessionId: string, targetId: string): Promise<SessionSnapshot>;
  /** `/fork`: the new session, and the forked message's text for the input box. */
  fork(sessionId: string, messageId: string): Promise<{ snapshot: SessionSnapshot; text: string }>;
  compact(sessionId: string, instructions?: string): Promise<CompactionOutcome>;
  status(sessionId: string): Promise<SessionStatus>;
  thinking(sessionId: string): Promise<{ level: ThinkingLevel; levels: ThinkingLevel[] }>;
  setThinking(
    sessionId: string,
    level: ThinkingLevel,
  ): Promise<{ level: ThinkingLevel; levels: ThinkingLevel[] }>;
  rename(sessionId: string, name: string): Promise<SessionSnapshot>;
  exportSession(
    sessionId: string,
    format: "html" | "jsonl",
    opts?: { path?: string; overwrite?: boolean },
  ): Promise<string>;
  /** `/copy`: undefined before the first reply. */
  lastReply(sessionId: string): Promise<string | undefined>;
  mode(sessionId: string): Promise<{ mode: SafetyMode; source: "session" | "config" }>;
  setMode(sessionId: string, mode: SafetyMode): Promise<{ mode: SafetyMode; source: "session" }>;
  compat(sessionId: string): Promise<SessionCompat>;
}

/** A request the daemon refused: its reason as the message, and the HTTP status. */
export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

export const DAEMON_OUTDATED =
  "hamness was updated; restart the daemon with `hamness stop`, then run hamness again";

/**
 * A daemon still running an older hamness: another version, or an API without a feature this
 * client needs. An old daemon would ignore `start: "new"` and attach to the latest session.
 */
function outdated(status: Extract<DaemonStatus, { running: true }>): boolean {
  if (status.version !== VERSION) return true;
  return DAEMON_FEATURES.some((f) => !status.features?.includes(f));
}

/**
 * Makes sure a daemon serves `dataDir`: if none answers, starts `hamness daemon` detached
 * (output to `<dataDir>/daemon.log`) and polls its status until it is up.
 */
export async function ensureDaemon(
  dataDir: string,
  opts: { env?: Env; timeoutMs?: number } = {},
): Promise<{ url: string; started: boolean }> {
  const now = await getStatus(dataDir);
  if (now.running) {
    if (outdated(now)) throw new Error(DAEMON_OUTDATED);
    return { url: now.url, started: false };
  }

  ensureDataDir(dataDir);
  const logPath = join(dataDir, "daemon.log");
  const log = openSync(logPath, "a", 0o600);
  const logStart = statSync(logPath).size;
  // Like main.ts's shebang: ignore the bunfig.toml of the folder the child inherits.
  const child = spawn(process.execPath, ["--config=/dev/null", MAIN, "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...(opts.env ?? process.env), HAMNESS_HOME: dataDir },
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const status = await getStatus(dataDir, 500);
    if (status.running) return { url: status.url, started: true };
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  const why = lastLogError(logPath, logStart);
  throw new Error(
    why
      ? `the hamness daemon did not start: ${why}`
      : `the hamness daemon did not start; see ${logPath}`,
  );
}

/** The daemon's own last error line in its log, written after `from` (this start's output). */
function lastLogError(path: string, from: number): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").slice(from).split("\n");
    const errors = lines.filter((l) => /^hamness( daemon)?: /.test(l) && !/judge is off/.test(l));
    return errors.at(-1)?.replace(/^hamness( daemon)?: /, "");
  } catch {
    return undefined;
  }
}

/** A client for the daemon that serves `dataDir`, using its token file. */
export async function connectToDaemon(dataDir: string): Promise<DaemonClient & SessionCommands> {
  const status = await getStatus(dataDir);
  if (!status.running) throw new Error("the hamness daemon is not running");
  const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  return httpClient(status.url, token);
}

export function httpClient(url: string, token: string): DaemonClient & SessionCommands {
  async function send(method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    return { res, parsed };
  }
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { res, parsed } = await send(method, path, body);
    if (!res.ok) {
      throw new DaemonError(parsed.error ?? `${method} ${path}: HTTP ${res.status}`, res.status);
    }
    return parsed as T;
  }
  const s = (id: string, action: string) => `/v1/sessions/${encodeURIComponent(id)}/${action}`;

  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  return {
    ready,
    attach: (cwd, how = { kind: "continue" }) =>
      call<SessionSnapshot>("POST", "/v1/sessions", {
        cwd,
        ...(how.kind === "session" ? { sessionId: how.id } : { start: how.kind }),
      }),
    prompt: async (id, text) => {
      await call("POST", `/v1/sessions/${encodeURIComponent(id)}/prompt`, { text });
    },
    abort: async (id) => {
      await call("POST", `/v1/sessions/${encodeURIComponent(id)}/abort`);
    },
    models: async () => (await call<{ models: ModelInfo[] }>("GET", "/v1/models")).models,
    setModel: (id, model) =>
      call<SessionSnapshot>("POST", `/v1/sessions/${encodeURIComponent(id)}/model`, { model }),
    answerApproval: async (id, decision) => {
      await call("POST", `/v1/approvals/${encodeURIComponent(id)}`, { decision });
    },
    resumeJudge: async (id) =>
      (
        await call<{ judge: JudgeState }>("POST", `/v1/sessions/${encodeURIComponent(id)}/judge`, {
          paused: false,
        })
      ).judge,
    task: async (id, action) => {
      const base = `/v1/sessions/${encodeURIComponent(id)}`;
      const res =
        action.kind === "start"
          ? await call<{ task: TaskView }>("POST", `${base}/task`, { goal: action.goal })
          : await call<{ task: TaskView }>("POST", `${base}/${action.kind}`, {
              ...(action.reason ? { reason: action.reason } : {}),
            });
      return res.task;
    },
    newSession: (id) => call<SessionSnapshot>("POST", s(id, "new"), {}),
    listSessions: async (cwd, current) =>
      (
        await call<{ sessions: SessionListItem[] }>(
          "GET",
          `/v1/sessions?cwd=${encodeURIComponent(cwd)}${
            current ? `&current=${encodeURIComponent(current)}` : ""
          }`,
        )
      ).sessions,
    resume: (id, targetId) =>
      call<SessionSnapshot>("POST", s(id, "resume"), { sessionId: targetId }),
    fork: (id, messageId) =>
      call<{ snapshot: SessionSnapshot; text: string }>("POST", s(id, "fork"), { messageId }),
    compact: (id, instructions) =>
      call<CompactionOutcome>("POST", s(id, "compact"), instructions ? { instructions } : {}),
    status: (id) => call<SessionStatus>("GET", s(id, "status")),
    thinking: (id) => call("GET", s(id, "thinking")),
    setThinking: (id, level) => call("POST", s(id, "thinking"), { level }),
    rename: (id, name) => call<SessionSnapshot>("POST", s(id, "name"), { name }),
    exportSession: async (id, format, opts = {}) =>
      (await call<{ path: string }>("POST", s(id, "export"), { format, ...opts })).path,
    lastReply: async (id) => {
      const { res, parsed } = await send("GET", s(id, "last-reply"));
      if (res.status === 404 && parsed.error === "no reply yet") return undefined;
      if (!res.ok)
        throw new DaemonError(parsed.error ?? `last-reply: HTTP ${res.status}`, res.status);
      return (parsed as { text: string }).text;
    },
    mode: (id) => call("GET", s(id, "mode")),
    setMode: (id, mode) => call("POST", s(id, "mode"), { mode }),
    compat: (id) => call<SessionCompat>("GET", s(id, "compat")),
    subscribe(onEvent) {
      const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/events?token=${token}`);
      ws.onopen = () => markReady();
      ws.onmessage = (e) => onEvent(JSON.parse(String(e.data)) as HamnessEvent);
      return () => ws.close();
    },
  };
}
