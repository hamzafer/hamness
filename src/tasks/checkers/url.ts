import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext } from "./context.ts";

export const DEFAULT_URL_TIMEOUT_S = 15;

type UrlClaim = Extract<EvidenceClaim, { kind: "url" }>;

/** Fetches the URL itself (following redirects); a 2xx passes. The body is not kept. */
export async function checkUrl(claim: UrlClaim, ctx: CheckContext): Promise<CheckResult> {
  const timeoutS = claim.timeoutSeconds ?? DEFAULT_URL_TIMEOUT_S;
  const signals = [AbortSignal.timeout(timeoutS * 1000), ...(ctx.signal ? [ctx.signal] : [])];
  const started = performance.now();
  try {
    const res = await ctx.fetch(claim.url, { redirect: "follow", signal: AbortSignal.any(signals) });
    await res.body?.cancel().catch(() => {});
    const durationMs = Math.round(performance.now() - started);
    const details = { url: claim.url, statusCode: res.status, finalUrl: res.url || claim.url, durationMs };
    const ok = res.status >= 200 && res.status < 300;
    return { status: ok ? "passed" : "failed", summary: `HTTP ${res.status} in ${durationMs}ms`, details };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const e = err as Error;
    if (ctx.signal?.aborted) {
      return { status: "error", summary: "aborted before it finished", details: { url: claim.url, durationMs } };
    }
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return {
      status: "failed",
      summary: timedOut ? `timed out after ${timeoutS}s` : `fetch failed: ${e.message}`,
      details: { url: claim.url, durationMs, error: timedOut ? "timeout" : e.message },
    };
  }
}
