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
 * - IPv6 forms that embed an IPv4 address (mapped, compatible, 6to4, NAT64, Teredo) are judged
 *   by that IPv4 address; a host that can't be resolved is not fetched (fail closed);
 * - redirects are followed only on the same host, scheme and port, each hop checked again.
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
        if (next.hostname !== host || next.protocol !== url.protocol || next.port !== url.port) {
          const where =
            next.hostname !== host ? "another host" : "another scheme or port on the same host";
          return {
            status: "error",
            summary: `not followed: HTTP ${res.status} redirects to ${where} (${next.protocol}//${next.host})`,
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
    } catch (err) {
      // Fail closed: an address hamness could not check is not fetched.
      return `could not resolve ${url.hostname} to check its address (${(err as Error).message})`;
    }
    if (addresses.length === 0) return `could not resolve ${url.hostname} to check its address`;
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
  const g = v6(ip);
  if (!g) return true; // not an address hamness can read: refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const tail = embedded(g6, g7);
  // ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0/96 (mapped) and
  // ::ffff:0:0:0/96 (SIIT): the IPv4 address in the last 32 bits decides.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    if (g4 === 0 && (g5 === 0 || g5 === 0xffff)) return isInternalAddress(tail);
    if (g4 === 0xffff && g5 === 0) return isInternalAddress(tail);
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // 64:ff9b::/96 NAT64 reaches the embedded IPv4; 64:ff9b:1::/48 is local-use.
    return g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0 || isInternalAddress(tail);
  }
  if (g0 === 0x2002) return isInternalAddress(embedded(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) {
    // Teredo: the client's IPv4, bits inverted, is in the last 32 bits.
    return isInternalAddress(embedded(~g6 & 0xffff, ~g7 & 0xffff));
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) || // 100::/64 discard
    (g0 === 0x2001 && g1 === 0xdb8) || // documentation
    g0 === 0 // anything else in ::/16 is reserved
  );
}

const embedded = (hi: number, lo: number) => [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join(".");

/** An IPv6 address as its eight 16-bit groups (`::` expanded, a dotted IPv4 tail read). */
function v6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1] && dotted[2]) {
    const four = v4(dotted[2]);
    if (!four) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = four;
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0] ?? "");
  const rest = halves.length === 2 ? part(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return undefined;
  return groups.map((x) => parseInt(x, 16));
}
