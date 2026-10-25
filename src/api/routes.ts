import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ModelSwitchError,
  SESSION_NAME_MAX,
  SessionBusyError,
  SessionCommandError,
  type SessionHub,
} from "../agent/session-hub.ts";
import type { ApprovalDecision, SafetyMode } from "../events/types.ts";
import { TaskStateError } from "../tasks/session-tasks.ts";
import type { TaskAction } from "../tasks/types.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MAX_BODY = 1_000_000;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The session routes, behind the token check:
 * - `POST /v1/sessions {cwd}`: attach to the cwd's session (created if needed); returns a snapshot
 * - `GET /v1/sessions/:id`: the snapshot
 * - `POST /v1/sessions/:id/prompt {text}`: 202 `{messageId}`; the reply streams on `/v1/events`
 * - `POST /v1/sessions/:id/abort`: stops the run; pending approvals become denies
 * - `POST /v1/sessions/:id/model {model}`: switch to `provider/id`; returns the snapshot
 * - `POST /v1/sessions/:id/judge {paused: false}`: resumes a paused judge; returns `{judge}`
 * - `GET /v1/models`: the models a session can switch to
 * - `POST /v1/sessions/:id/task {goal}`: the user opens a task (`/task`); 201 `{task}`
 * - `POST /v1/sessions/:id/override {reason?}`: the user accepts the open or unverified task
 * - `POST /v1/sessions/:id/abandon {reason?}`: the user drops the open task
 *   (all three: 409 when the task state doesn't allow it)
 * - `POST /v1/approvals/:id {decision}`: answers an approval (`allow-once`, `allow-always`, `deny`)
 * - `GET /v1/sessions?cwd=`: the cwd's sessions, for `/resume`
 * - the slash-command routes in `COMMANDS` below: new, resume, fork, compact, status, thinking,
 *   name, export, last-reply, mode, compat (ADR 0021)
 */
export function sessionRoutes(hub: SessionHub) {
  return async (req: Request, url: URL): Promise<Response | undefined> => {
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "sessions", id?, action?]
    if (parts[0] === "v1" && parts[1] === "approvals") return approvalRoute(hub, req, parts);
    if (parts[0] === "v1" && parts[1] === "models" && parts.length === 2 && req.method === "GET") {
      try {
        return json({ models: await hub.models() });
      } catch (err) {
        return json({ error: `could not list models: ${(err as Error).message}` }, 500);
      }
    }
    if (parts[0] !== "v1" || parts[1] !== "sessions") return undefined;
    const [, , id, action, extra] = parts;
    if (extra !== undefined) return undefined;

    if (!id && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd || !isAbsolute(cwd)) return json({ error: "cwd must be an absolute path" }, 400);
      return json({ sessions: await hub.listSessions(cwd) });
    }
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const cwd = body?.cwd;
      if (typeof cwd !== "string" || !isAbsolute(cwd) || !isDirectory(cwd)) {
        return json({ error: "cwd must be an absolute path to an existing directory" }, 400);
      }
      try {
        return json(await hub.attach(cwd));
      } catch (err) {
        return json({ error: `could not start the session: ${(err as Error).message}` }, 500);
      }
    }
    if (!id) return undefined;

    if (!action && req.method === "GET") {
      const snap = hub.snapshot(id);
      return snap ? json(snap) : json({ error: "no such session" }, 404);
    }
    if (action === "prompt" && req.method === "POST") {
      if (!hub.snapshot(id)) return json({ error: "no such session" }, 404);
      const body = await readJson(req);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "text must be a non-empty string" }, 400);
      try {
        return json({ messageId: hub.prompt(id, text) }, 202);
      } catch (err) {
        if (err instanceof SessionBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    }
    if (action === "model" && req.method === "POST") {
      if (!hub.snapshot(id)) return json({ error: "no such session" }, 404);
      const body = await readJson(req);
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!model) return json({ error: "model must be a provider/id string" }, 400);
      try {
        return json(await hub.setModel(id, model));
      } catch (err) {
        if (err instanceof ModelSwitchError) return json({ error: err.message }, 400);
        if (err instanceof SessionBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    }
    if (action === "judge" && req.method === "POST") {
      if (!hub.snapshot(id)) return json({ error: "no such session" }, 404);
      const body = await readJson(req);
      if (body?.paused !== false) return json({ error: 'send {"paused": false}' }, 400);
      const judge = hub.resumeJudge(id);
      return judge ? json({ judge }) : json({ error: "this session has no judge" }, 409);
    }
    if (
      (action === "task" || action === "override" || action === "abandon") &&
      req.method === "POST"
    ) {
      if (!hub.snapshot(id)) return json({ error: "no such session" }, 404);
      const body = await readJson(req);
      if (!body) return json({ error: "body must be a JSON object" }, 400);
      const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      let taskAction: TaskAction;
      if (action === "task") {
        const goal = text(body.goal);
        if (!goal) return json({ error: "goal must be a non-empty string" }, 400);
        taskAction = { kind: "start", goal };
      } else {
        const reason = text(body.reason);
        taskAction = { kind: action, ...(reason ? { reason } : {}) };
      }
      try {
        const task = hub.taskAction(id, taskAction);
        return json({ task }, action === "task" ? 201 : 200);
      } catch (err) {
        if (err instanceof TaskStateError) return json({ error: err.message }, 409);
        throw err;
      }
    }
    if (action === "abort" && req.method === "POST") {
      return (await hub.abort(id)) ? json({ ok: true }) : json({ error: "no such session" }, 404);
    }
    if (action && action in COMMANDS) {
      const route = COMMANDS[action]?.[req.method];
      if (!route) return undefined;
      const body = req.method === "POST" ? await readJson(req) : {};
      if (!body) return json({ error: "body must be a JSON object" }, 400);
      try {
        return await route(hub, id, body);
      } catch (err) {
        if (err instanceof SessionCommandError) return json({ error: err.message }, err.status);
        if (err instanceof SessionBusyError) return json({ error: err.message }, 409);
        if (err instanceof ModelSwitchError) return json({ error: err.message }, 400);
        throw err;
      }
    }
    return undefined;
  };
}

type CommandRoute = (
  hub: SessionHub,
  id: string,
  body: Record<string, unknown>,
) => Response | Promise<Response>;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const SAFETY_MODES = new Set<string>(["ask", "auto", "yolo"]);

/**
 * The slash-command routes, `/v1/sessions/:id/<action>` (ADR 0021). Each throws
 * `SessionCommandError` (its status), `SessionBusyError` (409) or answers itself.
 */
const COMMANDS: Record<string, Record<string, CommandRoute>> = {
  new: { POST: async (hub, id) => json(await hub.newSession(id)) },
  resume: {
    POST: async (hub, id, body) => {
      const target = str(body.sessionId);
      if (!target) return json({ error: "sessionId must be a session id" }, 400);
      return json(await hub.resume(id, target));
    },
  },
  fork: {
    POST: async (hub, id, body) => {
      const messageId = str(body.messageId);
      if (!messageId) return json({ error: "messageId must be a user message id" }, 400);
      return json(await hub.fork(id, messageId), 201);
    },
  },
  compact: {
    POST: async (hub, id, body) => {
      if (body.instructions !== undefined && typeof body.instructions !== "string") {
        return json({ error: "instructions must be a string" }, 400);
      }
      const instructions = str(body.instructions);
      return json(await hub.compact(id, instructions || undefined));
    },
  },
  status: { GET: (hub, id) => json(hub.status(id)) },
  thinking: {
    GET: (hub, id) => json(hub.thinking(id)),
    POST: (hub, id, body) => {
      const level = str(body.level);
      if (!level) return json({ error: "level must be a thinking level" }, 400);
      return json(hub.setThinking(id, level));
    },
  },
  name: {
    POST: (hub, id, body) => {
      const name = str(body.name).replace(/\s+/g, " ");
      if (!name || name.length > SESSION_NAME_MAX) {
        return json({ error: `name must be 1 to ${SESSION_NAME_MAX} characters` }, 400);
      }
      return json(hub.rename(id, name));
    },
  },
  export: {
    POST: async (hub, id, body) => {
      const format = body.format ?? "html";
      if (format !== "html" && format !== "jsonl") {
        return json({ error: "format must be html or jsonl" }, 400);
      }
      if (body.path !== undefined && (typeof body.path !== "string" || !body.path.trim())) {
        return json({ error: "path must be a non-empty string" }, 400);
      }
      const path = await hub.exportSession(id, format, {
        ...(typeof body.path === "string" ? { path: body.path.trim() } : {}),
        overwrite: body.overwrite === true,
      });
      return json({ path, format });
    },
  },
  "last-reply": {
    GET: (hub, id) => {
      const text = hub.lastReply(id);
      return text === undefined ? json({ error: "no reply yet" }, 404) : json({ text });
    },
  },
  mode: {
    GET: (hub, id) => json(hub.mode(id)),
    POST: (hub, id, body) => {
      const mode = str(body.mode);
      if (!SAFETY_MODES.has(mode)) return json({ error: "mode must be ask, auto or yolo" }, 400);
      return json(hub.setMode(id, mode as SafetyMode));
    },
  },
  compat: { GET: (hub, id) => json(hub.compatInfo(id)) },
};

const DECISIONS = new Set<ApprovalDecision>(["allow-once", "allow-always", "deny"]);

async function approvalRoute(
  hub: SessionHub,
  req: Request,
  parts: string[],
): Promise<Response | undefined> {
  const [, , id, extra] = parts;
  if (!id || extra !== undefined || req.method !== "POST") return undefined;
  const body = await readJson(req);
  const decision = body?.decision;
  if (typeof decision !== "string" || !DECISIONS.has(decision as ApprovalDecision)) {
    return json({ error: "decision must be allow-once, allow-always or deny" }, 400);
  }
  return hub.answerApproval(id, decision as ApprovalDecision)
    ? json({ ok: true })
    : json({ error: "no such pending approval" }, 404);
}
