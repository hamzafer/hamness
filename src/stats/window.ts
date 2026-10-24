export const RANGES = ["24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

export const SOURCES = ["hamness", "claude-code", "codex"] as const;
export type Source = (typeof SOURCES)[number];

export interface StatsQuery {
  range: Range;
  /** Only sessions from this source (and their calls, tasks and decisions). */
  source?: Source | undefined;
  /** "Now" in ms since the epoch. Defaults to `Date.now()`. */
  now?: number | undefined;
  /**
   * Offset of the viewer's local time from UTC, in minutes (UTC+2 is 120), so
   * day buckets start at local midnight. Defaults to this machine's offset at `now`.
   */
  utcOffsetMinutes?: number | undefined;
}

export interface Window {
  /** First bucket start, inclusive (ms). */
  from: number;
  /** `now`, inclusive (ms). */
  to: number;
  bucketMs: number;
  buckets: number;
  source: Source | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The time window of a range, aligned to whole buckets: 24h is the current
 * hour plus the 23 before it; 7d, 30d and 90d are today plus the days before
 * it, in local time. DST shifts inside the window are ignored.
 */
export function windowFor(q: StatsQuery): Window {
  const now = q.now ?? Date.now();
  const offsetMs = (q.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()) * 60_000;
  const [bucketMs, buckets] = q.range === "24h" ? [HOUR, 24] : [DAY, Number.parseInt(q.range, 10)];
  const local = now + offsetMs;
  const currentStart = local - (((local % bucketMs) + bucketMs) % bucketMs) - offsetMs;
  return {
    from: currentStart - (buckets - 1) * bucketMs,
    to: now,
    bucketMs,
    buckets,
    source: q.source ?? null,
  };
}
