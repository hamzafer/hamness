import type { ModelChoice } from "../agent/models.ts";
import { resolveModels } from "../agent/models.ts";
import { SessionHub } from "../agent/session-hub.ts";
import { generateToken, writeTokenFile } from "../api/auth.ts";
import { dashboardMount } from "../api/dashboard-routes.ts";
import { sessionRoutes } from "../api/routes.ts";
import { assertPortFree, startApiServer } from "../api/server.ts";
import { claudePermissionMode, createClaudeHooks } from "../compat/hooks.ts";
import { claudeConfigDir, claudeManagedDir, managedDirOption } from "../compat/paths.ts";
import { dataPaths, ensureDataDir } from "../config/paths.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import type { HamnessEvent } from "../events/types.ts";
import { createSafetyService, type SafetyCheck } from "../safety/index.ts";
import { type BackendJudge, createJudgeController } from "../safety/judge/index.ts";
import { VERSION } from "../version.ts";
import { describeDaemon, type FoundDaemon, findDaemons } from "./processes.ts";
import { claimState, type DaemonState, releaseState, writeState } from "./state.ts";
import { DAEMON_FEATURES, getStatus } from "./status.ts";

/** The default API port. `HAMNESS_PORT` or `--port` overrides it; 0 picks a free one. */
export const DEFAULT_PORT = 7357;

export interface DaemonOptions {
  dataDir: string;
  port?: number;
  /** The model for new sessions. Default: Claude, keyed from the env or the key file. Tests pass a fake. */
  models?: () => Promise<ModelChoice>;
  /** Replaces the rules-based check every tool call passes (tests). */
  safety?: SafetyCheck;
  /**
   * The judge model for calls no rule decides, in `auto` mode. The daemon adds the deadline,
   * daily budget and back-off. None: no API key, so undecided calls ask.
   */
  judge?: BackendJudge;
  /** Load Claude Code's instructions, skills and MCP servers into sessions. Default true; tests turn it off. */
  contextFiles?: boolean;
  /** Claude Code's config dir, for its hooks. Default `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeConfigDir?: string;
  /** Claude Code's managed policy folder, for managed hooks. Default the platform's; tests set it. */
  claudeManagedDir?: string;
  /** How long to wait for another daemon still holding the data dir to exit. Default 7 s. */
  strayWaitMs?: number;
}

export interface RunningDaemon {
  readonly pid: number;
  readonly url: string;
  readonly wsUrl: string;
  readonly db: HamnessDb;
  /** Broadcasts to every connected client. */
  emit(event: HamnessEvent): void;
  /**
   * Ends the sessions (and their MCP servers), the API server and its connections, then the
   * database, and gives up the data dir. Bounded by `deadlineMs` (default 5 s): what had not
   * finished by then is named in `open`, and the database and state files are closed anyway.
   */
  stop(opts?: { deadlineMs?: number }): Promise<StopReport>;
}

export interface StopReport {
  /** Shutdown steps still unfinished at the deadline; empty when everything closed. */
  open: string[];
}

/** How long `stop()` waits for sessions and connections to close before giving up on them. */
export const STOP_DEADLINE_MS = 5000;

export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly owner: DaemonState,
    detail?: string,
  ) {
    super(
      detail ??
        `hamness daemon is already running (pid ${owner.pid}${owner.url ? `, ${owner.url}` : ""})`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

/**
 * Another daemon process on the data dir: one still shutting down (a quick restart), one that
 * stopped serving but never exited, or one a scan finds without a lock. Two daemons must
 * never share the DB. A daemon holding the lock gets `waitMs` to exit first. A process only a
 * scan finds counts once it is a few seconds old, so one that lost a start race never blocks.
 */
async function blockingDaemon(
  dataDir: string,
  self: number,
  waitMs: number,
): Promise<FoundDaemon | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const other = findDaemons(dataDir).find(
      (p) => p.pid !== self && (p.locked || p.ageSeconds >= 5),
    );
    if (!other?.locked || Date.now() >= deadline) return other;
    await Bun.sleep(100);
  }
}

/** How long a start waits for a daemon still shutting down on the data dir. */
export const STRAY_WAIT_MS = 7000;

/** Pids whose lock file this process removes on exit (tests start several daemons in one). */
const heldLocks = new Map<string, number>();
let exitHookInstalled = false;

function holdLock(path: string, pid: number, startedAt: number): void {
  writeState(path, { pid, startedAt });
  heldLocks.set(path, pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const [lock, owner] of heldLocks) releaseState(lock, owner);
  });
}

function releaseLock(path: string, pid: number): void {
  if (heldLocks.get(path) === pid) heldLocks.delete(path);
  releaseState(path, pid);
}

/**
 * Starts the daemon: claims the data dir, migrates the database,
 * rotates the token and serves the localhost API.
 */
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const paths = dataPaths(opts.dataDir);
  const pid = process.pid;
  ensureDataDir(paths.dataDir);

  let claim = claimState(paths.daemonState, pid);
  if (!claim.ok && claim.owner.url && !(await getStatus(opts.dataDir)).running) {
    // The pid is alive but nothing answers at its url: the pid was reused after a crash.
    releaseState(paths.daemonState, claim.owner.pid);
    claim = claimState(paths.daemonState, pid);
  }
  if (!claim.ok) throw new DaemonAlreadyRunningError(claim.owner);
  const stray = await blockingDaemon(opts.dataDir, pid, opts.strayWaitMs ?? STRAY_WAIT_MS);
  if (stray) {
    releaseState(paths.daemonState, pid);
    throw new DaemonAlreadyRunningError(
      { pid: stray.pid },
      `another hamness daemon process still runs on this data dir (${describeDaemon(stray)}) without answering; stop it with \`hamness stop --all\``,
    );
  }

  let db: HamnessDb | undefined;
  try {
    await assertPortFree(opts.port ?? DEFAULT_PORT);
    db = openDatabase(paths.database);
    const openDb = db;
    const token = generateToken();
    writeTokenFile(paths.token, token);

    const startedAt = Date.now();
    holdLock(paths.daemonLock, pid, startedAt);
    let publish: (event: HamnessEvent) => void = () => {};
    const hooks = createClaudeHooks({
      claudeDir: opts.claudeConfigDir ?? claudeConfigDir(process.env),
      dataDir: paths.dataDir,
      ...managedDirOption(opts.claudeManagedDir ?? claudeManagedDir({ env: process.env })),
    });
    let hubRef: SessionHub | undefined;
    const judge = opts.safety
      ? undefined
      : createJudgeController({
          db: openDb,
          dataDir: paths.dataDir,
          ...(opts.judge ? { backend: opts.judge } : {}),
          onState: (sessionId, state, reason) => hubRef?.judgeChanged(sessionId, state, reason),
        });
    const rules = judge
      ? createSafetyService({
          db: openDb,
          dataDir: paths.dataDir,
          judge: judge.judge,
          preToolHook: async (call, mode) => {
            const out = await hooks.preToolUse(
              {
                sessionId: call.sessionId,
                cwd: call.cwd ?? "",
                ...(call.transcriptPath ? { transcriptPath: call.transcriptPath } : {}),
                permissionMode: claudePermissionMode(mode),
              },
              { tool: call.tool, args: call.args, toolUseId: call.toolCallId },
            );
            return out && { verdict: out.decision, reason: out.reason, hook: `hook: ${out.hook}` };
          },
        })
      : undefined;
    const hub = new SessionHub({
      db: openDb,
      dataDir: paths.dataDir,
      models: opts.models ?? (() => resolveModels({ dataDir: paths.dataDir, env: process.env })),
      safety: opts.safety ?? (rules as NonNullable<typeof rules>).check,
      ...(rules ? { safetyModes: rules } : {}),
      ...(judge ? { judge } : {}),
      ...(opts.contextFiles !== undefined ? { contextFiles: opts.contextFiles } : {}),
      hooks,
      publish: (event) => publish(event),
    });
    hubRef = hub;
    let stopping: Promise<StopReport> | undefined;
    const api = startApiServer({
      token,
      port: opts.port ?? DEFAULT_PORT,
      // Undefined once stopping: health answers 503, so a client or a new daemon sees it gone.
      health: () =>
        stopping
          ? undefined
          : {
              ok: true,
              version: VERSION,
              pid,
              schemaVersion: openDb.schemaVersion(),
              features: DAEMON_FEATURES,
            },
      hello: () => ({
        type: "daemon.hello",
        version: VERSION,
        pid,
        schemaVersion: openDb.schemaVersion(),
      }),
      routes: sessionRoutes(hub),
      dashboard: dashboardMount(openDb),
    });
    publish = (event) => api.publish(event);
    writeState(paths.daemonState, { pid, url: api.url, startedAt });

    return {
      pid,
      url: api.url,
      wsUrl: api.wsUrl,
      db: openDb,
      emit: (event) => api.publish(event),
      stop(stopOpts = {}) {
        stopping ??= (async () => {
          const end = Date.now() + (stopOpts.deadlineMs ?? STOP_DEADLINE_MS);
          const open: string[] = [];
          /** Runs one step until it settles or the shared deadline passes. */
          const step = async (name: string, run: () => Promise<unknown>) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(250, end - Date.now()));
            });
            const settled = Promise.resolve()
              .then(run)
              .then(
                () => true,
                () => true,
              );
            if (!(await Promise.race([settled, late]))) open.push(name);
            clearTimeout(timer);
          };
          api.publish({ type: "daemon.stopping" });
          await step("sessions and their MCP servers", () => hub.stop());
          await step("the API server and its connections", () => api.stop());
          try {
            openDb.close();
          } catch {
            open.push("the database");
          }
          releaseState(paths.daemonState, pid);
          return { open };
        })();
        return stopping;
      },
    };
  } catch (err) {
    db?.close();
    releaseLock(paths.daemonLock, pid);
    releaseState(paths.daemonState, pid);
    throw err;
  }
}
