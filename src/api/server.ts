import type { Server } from "bun";
import type { HamnessEvent } from "../events/types.ts";
import { tokenFromRequest, tokensMatch } from "./auth.ts";

/** The only interface the API binds to. Never 0.0.0.0. */
export const API_HOSTNAME = "127.0.0.1";
const EVENTS_TOPIC = "events";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ApiOptions {
  token: string;
  port: number;
  /** Body of `GET /v1/health`. */
  health: () => Record<string, unknown>;
  /** First event a new WebSocket client receives. */
  hello: () => HamnessEvent;
  /** Feature routes, called after the token check. Return undefined for "not mine". */
  routes?: (req: Request, url: URL) => Promise<Response | undefined>;
}

export interface ApiServer {
  readonly url: string;
  readonly wsUrl: string;
  readonly port: number;
  publish(event: HamnessEvent): void;
  stop(): Promise<void>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Rejects a Host header that isn't loopback, so a web page can't reach us via DNS rebinding. */
function isLocalHost(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name !== undefined && LOCAL_HOSTS.has(name);
}

export function startApiServer(opts: ApiOptions): ApiServer {
  const server: Server<undefined> = Bun.serve({
    hostname: API_HOSTNAME,
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!isLocalHost(req)) return json({ error: "forbidden host" }, 403);

      const isEvents = url.pathname === "/v1/events";
      if (!tokensMatch(opts.token, tokenFromRequest(req, url, isEvents))) {
        return json({ error: "unauthorized" }, 401);
      }

      if (isEvents) {
        if (srv.upgrade(req, { data: undefined })) return undefined;
        return json({ error: "expected a WebSocket upgrade" }, 426);
      }
      if (req.method === "GET" && url.pathname === "/v1/health") return json(opts.health());
      try {
        const res = await opts.routes?.(req, url);
        if (res) return res;
      } catch (err) {
        return json({ error: (err as Error).message }, 500);
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      open(ws) {
        ws.subscribe(EVENTS_TOPIC);
        ws.send(JSON.stringify(opts.hello()));
      },
      message() {
        // Clients only listen in v1; commands go over HTTP.
      },
    },
  });

  const port = server.port ?? opts.port;
  return {
    url: `http://${API_HOSTNAME}:${port}`,
    wsUrl: `ws://${API_HOSTNAME}:${port}`,
    port,
    publish: (event) => {
      server.publish(EVENTS_TOPIC, JSON.stringify(event));
    },
    stop: () => server.stop(true),
  };
}
