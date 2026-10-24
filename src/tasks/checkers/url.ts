import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SafetyVerdict } from "../../safety/index.ts";
import { PROVE_URL } from "../../safety/rules.ts";
import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext } from "./context.ts";

export const DEFAULT_URL_TIMEOUT_S = 15;
/** Redirects followed on the same host before giving up. */
const MAX_REDIRECTS = 5;

type UrlClaim = Extract<EvidenceClaim, { kind: "url" }>;

/**
 * Fetches the URL itself; a 2xx passes. The body is not kept. Before anything is sent (S-H3):
 *
 * - the URL passes the session's safety check as its own tool, `prove_url` (no rule allows it
 *   by default, so the judge or the user decides: a URL can carry data out);
 * - its host must not resolve to a loopback, private, link-local or other internal address,
 *   unless the user config sets `proof.allowPrivateUrls` (a local dev server);
 * - redirects are followed only on the same host, each hop checked the same way.
 *
 * The host is resolved here and again by fetch, so a name that changes its answer in between
 * (DNS rebinding) is not caught; `allowPrivateUrls` off still stops the plain cases.
 */
export async function checkUrl(claim: UrlClaim, ctx: CheckContext): Promise<CheckResult> {
  const timeoutS = claim.timeoutSeconds ?? DEFAULT_URL_TIMEOUT_S;
  const base = { url: claim.url };
  let verdict: SafetyVerdict;
  try {
    verdict = await ctx.safety({
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      tool: PROVE_URL,
      args: { url: claim.url },
      cwd: ctx.cwd,
    });
  } catch (err) {
    verdict = { allow: false, reason: `safety check failed: ${(err as Error).message}` };
  }
  if (!verdict.allow) {
    return {
      status: "error",
      summary: `not fetched: blocked by safety (${verdict.reason})`,
      details: { ...base, blocked: verdict.reason },
    };
  }

  const signals = [AbortSignal.timeout(timeoutS * 1000), ...(ctx.signal ? [ctx.signal] : [])];
  const signal = AbortSignal.any(signals);
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let url = new URL(claim.url);
  const host = url.hostname;
  try {
    for (let hop = 0; ; hop++) {
      const refused = await refusedAddress(url, ctx);
      if (refused) {
        return {
          status: "error",
          summary: `not fetched: ${refused} (set proof.allowPrivateUrls in the user config to allow it)`,
          details: { ...base, blocked: refused, durationMs: ms() },
        };
      }
      const res = await ctx.fetch(url.href, { redirect: "manual", signal });
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url);
        if (next.hostname !== host || (next.protocol !== "http:" && next.protocol !== "https:")) {
          return {
            status: "error",
            summary: `not followed: HTTP ${res.status} redirects to another host (${next.host})`,
            details: { ...base, statusCode: res.status, redirect: next.origin, durationMs: ms() },
          };
        }
        if (hop >= MAX_REDIRECTS) {
          return {
            status: "failed",
            summary: `more than ${MAX_REDIRECTS} redirects`,
            details: { ...base, statusCode: res.status, durationMs: ms() },
          };
        }
        url = next;
        continue;
      }
      const durationMs = ms();
      const details = { ...base, statusCode: res.status, finalUrl: url.href, durationMs };
      const ok = res.status >= 200 && res.status < 300;
      return {
        status: ok ? "passed" : "failed",
        summary: `HTTP ${res.status} in ${durationMs}ms`,
        details,
      };
    }
  } catch (err) {
    const durationMs = ms();
    const e = err as Error;
    if (ctx.signal?.aborted) {
      return {
        status: "error",
        summary: "aborted before it finished",
        details: { ...base, durationMs },
      };
    }
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return {
      status: "failed",
      summary: timedOut ? `timed out after ${timeoutS}s` : `fetch failed: ${e.message}`,
      details: { ...base, durationMs, error: timedOut ? "timeout" : e.message },
    };
  }
}

/** Why `url`'s host may not be fetched, or undefined. */
async function refusedAddress(url: URL, ctx: CheckContext): Promise<string | undefined> {
  if (ctx.allowPrivateUrls) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = await (ctx.lookup ?? systemLookup)(host);
    } catch {
      // Unresolvable: fetch fails on its own and reports it.
      return undefined;
    }
  }
  const internal = addresses.find(isInternalAddress);
  return internal ? `${url.hostname} is a private or local address (${internal})` : undefined;
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

function v4(ip: string): number[] | undefined {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

/** Loopback, private, link-local, CGNAT, unspecified, multicast and reserved ranges. */
export function isInternalAddress(ip: string): boolean {
  const a = v4(ip);
  if (a) {
    const [x = 0, y = 0] = a;
    return (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0 && a[2] === 0) ||
      (x === 198 && (y === 18 || y === 19)) ||
      x >= 224
    );
  }
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isInternalAddress(mapped[1]);
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isInternalAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // multicast
    s.startsWith("64:ff9b:") // NAT64 can reach IPv4 internals
  );
}
