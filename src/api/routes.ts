import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SessionBusyError, type SessionHub } from "../agent/session-hub.ts";
import type { ApprovalDecision } from "../events/types.ts";

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
 * - `POST /v1/approvals/:id {decision}`: answers an approval (`allow-once`, `allow-always`, `deny`)
 */
export function sessionRoutes(hub: SessionHub) {
  return async (req: Request, url: URL): Promise<Response | undefined> => {
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "sessions", id?, action?]
    if (parts[0] === "v1" && parts[1] === "approvals") return approvalRoute(hub, req, parts);
    if (parts[0] !== "v1" || parts[1] !== "sessions") return undefined;
    const [, , id, action, extra] = parts;
    if (extra !== undefined) return undefined;

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
    if (action === "abort" && req.method === "POST") {
      return (await hub.abort(id)) ? json({ ok: true }) : json({ error: "no such session" }, 404);
    }
    return undefined;
  };
}

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
