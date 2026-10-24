/**
 * The model price table: cost of imported history and of hamness's own model calls.
 * The numbers live in `price-data.ts` (one file, with its sources and the date they were checked).
 * Prices are USD per million tokens, so tokens times price is micro-dollars.
 */
import { PRICE_NOTES, PRICE_TABLE, type PriceEntry, type PriceRow } from "./price-data.ts";

export { PRICE_NOTES };
export type Price = PriceRow;
export type ModelPrice = PriceEntry;

export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** All cache writes, 5-minute and 1-hour. */
  cacheWrite: number;
  /** The part of `cacheWrite` kept for 1 hour (Anthropic reports the split; others don't). */
  cacheWrite1h?: number;
}

const PRICES = PRICE_TABLE;

/**
 * Strips a `provider/` prefix (`anthropic/claude-opus-5-5`), Claude Code's context suffix
 * (`[1m]`) and a dated snapshot suffix (`-20251001`).
 */
function normalize(model: string): string {
  return model
    .slice(model.lastIndexOf("/") + 1)
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

export function priceFor(model: string): ModelPrice | undefined {
  const id = normalize(model);
  return Object.hasOwn(PRICES, id) ? PRICES[id] : undefined;
}

/** Estimated cost of one model call in micro-dollars. 0 when the model has no price. */
export function estimateCostMicros(model: string, usage: TokenUsage): number {
  return costMicros(model, usage) ?? 0;
}

/** Cost of one model call in micro-dollars, or undefined when the model has no price. */
export function costMicros(model: string, usage: TokenUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  let rate: Price = price;
  for (const tier of price.tiers ?? []) if (prompt > tier.inputTokensAbove) rate = tier;
  // USD per MTok times tokens is micro-dollars directly.
  const longWrite = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
  return Math.round(
    usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheRead * rate.cacheRead +
      (usage.cacheWrite - longWrite) * rate.cacheWrite +
      longWrite * rate.cacheWrite1h,
  );
}
