/** Number formats shared by `hamness stats` and the dashboard. No imports: the browser bundles it. */

/** Micro-dollars as dollars: `$12.34`, `<$0.01`, `-` for none. */
export function money(micros: number | null): string {
  if (micros === null) return "-";
  if (micros > 0 && micros < 5_000) return "<$0.01";
  const dollars = micros / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Micro-dollars as a short axis label: `$2k`, `$2.5k`, `$1.3M`, `$750`, `$7.50`, `$0`. */
export function moneyCompact(micros: number): string {
  const dollars = micros / 1_000_000;
  const one = (x: number) => String(Number(x.toFixed(1)));
  if (dollars >= 1e6) return `$${one(dollars / 1e6)}M`;
  if (dollars >= 1e3) return `$${one(dollars / 1e3)}k`;
  if (dollars >= 10) return `$${Math.round(dollars)}`;
  if (dollars === 0) return "$0";
  return `$${dollars.toFixed(2)}`;
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

/**
 * Spend that may be on the ChatGPT plan: `$0 (plan)` when plan calls made it all $0 (as the TUI
 * says), else `money`. Never a bare `$0.00` for plan use.
 */
export function planMoney(costMicros: number, planCalls: number): string {
  return planCalls > 0 && costMicros === 0 ? "$0 (plan)" : money(costMicros);
}

/** A model's cost: `$0 (plan)` when every call was billed to the ChatGPT plan, else `money`. */
export function modelCost(m: { costMicros: number; calls: number; planCalls?: number }): string {
  const plan = m.planCalls ?? 0;
  if (plan > 0 && plan === m.calls) return "$0 (plan)";
  return plan > 0 ? `${money(m.costMicros)} (+plan)` : money(m.costMicros);
}
