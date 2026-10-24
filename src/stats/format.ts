/** Number formats shared by `hamness stats` and the dashboard. No imports: the browser bundles it. */

/** Micro-dollars as dollars: `$12.34`, `<$0.01`, `-` for none. */
export function money(micros: number | null): string {
  if (micros === null) return "-";
  if (micros > 0 && micros < 5_000) return "<$0.01";
  const dollars = micros / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 950, 12.3k, 4.5M, 1.2B. */
export function count(n: number): string {
  if (n < 1_000) return String(n);
  for (const [div, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const)
    if (n >= div) return `${(n / div).toFixed(1)}${unit}`;
  return String(n);
}

/** 45s, 12m, 3h 05m, 2d 4h. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
