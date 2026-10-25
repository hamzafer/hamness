/**
 * Web dashboard: a static page the daemon serves on localhost at `/dash` (ADR 0018).
 *
 * The page and its assets hold no data, so they are served without the token; the page
 * reads the token from the URL fragment that `hamness dashboard` opens (fragments never
 * reach the server or its logs), keeps it in sessionStorage and sends it as a Bearer
 * header to the JSON routes in `src/api/dashboard-routes.ts`.
 *
 * The client (`client/`) is plain TypeScript bundled by Bun on first request and cached.
 */
import { join } from "node:path";

const CLIENT_DIR = join(import.meta.dir, "client");

/** Nothing but our own script, styles and JSON; no framing, no referrer. */
export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

interface Asset {
  body: string;
  type: string;
}

const ORBS_NOTICE = "/*! thinking-orbs (c) 2026 Jakub Antalik, MIT, see src/orbs/LICENSE */";

let bundle: Promise<Asset> | undefined;

/** Bundles `client/main.ts` for the browser once per process. */
export function clientScript(): Promise<Asset> {
  bundle ??= (async () => {
    const out = await Bun.build({
      entrypoints: [join(CLIENT_DIR, "main.ts")],
      target: "browser",
      format: "esm",
      minify: true,
      // Minifying drops comments; the vendored orb engine's MIT notice must ship with it.
      banner: ORBS_NOTICE,
    });
    const file = out.outputs[0];
    if (!out.success || !file) {
      bundle = undefined;
      throw new Error(`dashboard bundle failed: ${out.logs.map(String).join("\n")}`);
    }
    return { body: await file.text(), type: "text/javascript; charset=utf-8" };
  })();
  return bundle;
}

const files: Record<string, () => Promise<Asset>> = {
  "/dash": async () => ({
    body: await Bun.file(join(CLIENT_DIR, "index.html")).text(),
    type: "text/html; charset=utf-8",
  }),
  "/dash/app.css": async () => ({
    body: await Bun.file(join(CLIENT_DIR, "styles.css")).text(),
    type: "text/css; charset=utf-8",
  }),
  "/dash/app.js": clientScript,
};

/** Serves the page and its assets; anything else is not ours (and goes through the token check). */
export async function dashboardPage(req: Request, url: URL): Promise<Response | undefined> {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  if (url.pathname === "/" || url.pathname === "/dash/")
    return new Response(null, { status: 302, headers: { location: "/dash", ...PAGE_HEADERS } });
  const load = files[url.pathname];
  if (!load) return undefined;
  const asset = await load();
  return new Response(asset.body, { headers: { "content-type": asset.type, ...PAGE_HEADERS } });
}
