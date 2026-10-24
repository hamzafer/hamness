/**
 * The price table, USD per million tokens. This is the one file to edit when prices change.
 *
 * Columns follow Anthropic's pricing table: base input, 5-minute cache write, 1-hour cache write,
 * cache read (hits and refreshes), output. `above` adds a tier that applies to the whole request
 * once its prompt (input + cache read + cache write) passes the threshold.
 *
 * Sources, checked 2026-10-24:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (model pricing table).
 *   Cache reads are 0.1x input, except 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1.
 *   5-minute writes are 1.25x input, 1-hour writes 2x.
 * - OpenAI: Pi's model catalog (`@earendil-works/pi-ai` 1.4.0, `providers/data/openai*.json`).
 *   OpenAI has no 1-hour cache write, so that column repeats the cache write price.
 *
 * Not modeled: batch, fast mode, data residency (`inference_geo`) multipliers.
 */

export interface PriceRow {
  input: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface PriceEntry extends PriceRow {
  tiers?: readonly (PriceRow & { inputTokensAbove: number })[];
}

const row = (
  input: number,
  cacheWrite: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
): PriceRow => ({ input, cacheWrite, cacheWrite1h, cacheRead, output });

/** A row without a 1-hour cache (OpenAI): the cache write price applies to every write. */
const flat = (input: number, cacheWrite: number, cacheRead: number, output: number) =>
  row(input, cacheWrite, cacheWrite, cacheRead, output);

const above = (inputTokensAbove: number, price: PriceRow) => ({ inputTokensAbove, ...price });

export const PRICE_TABLE: Readonly<Record<string, PriceEntry>> = {
  // Anthropic                     input  5m write  1h write  read   output
  "claude-fable-5-1": row(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": row(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": row(4, 5, 8, 0.2, 20),
  "claude-opus-5": row(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": row(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": row(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": row(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": row(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1": row(15, 18.75, 30, 1.5, 75),
  "claude-opus-4": row(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5-5": row(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": row(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": row(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": row(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4": row(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": {
    ...row(0.1, 0.125, 0.2, 0.01, 0.5),
    tiers: [above(100_000, row(0.5, 0.625, 1, 0.05, 2.5))],
  },
  "claude-haiku-4-5": row(1, 1.25, 2, 0.1, 5),

  // OpenAI                        input  write  read    output
  "gpt-6.1-sol": { ...flat(2, 2.5, 0.1, 10), tiers: [above(272_000, flat(4, 5, 0.2, 15))] },
  "gpt-6-sol": { ...flat(2, 2.5, 0.2, 10), tiers: [above(272_000, flat(4, 5, 0.4, 15))] },
  "gpt-6-astra": { ...flat(10, 12.5, 1, 50), tiers: [above(272_000, flat(20, 25, 2, 75))] },
  "gpt-6-luna": {
    ...flat(0.1, 0.125, 0.01, 0.5),
    tiers: [above(272_000, flat(0.2, 0.25, 0.02, 0.75))],
  },
  "gpt-5.6-sol": { ...flat(4, 5, 0.4, 20), tiers: [above(272_000, flat(8, 10, 0.8, 30))] },
  "gpt-5.6-terra": { ...flat(2, 2.5, 0.2, 12), tiers: [above(272_000, flat(4, 5, 0.4, 18))] },
  "gpt-5.6-luna": {
    ...flat(0.2, 0.25, 0.02, 1.2),
    tiers: [above(272_000, flat(0.4, 0.5, 0.04, 1.8))],
  },
  "gpt-5.5": { ...flat(5, 0, 0.5, 30), tiers: [above(272_000, flat(10, 0, 1, 45))] },
  "gpt-5.4": { ...flat(2.5, 0, 0.25, 15), tiers: [above(272_000, flat(5, 0, 0.5, 22.5))] },
  "gpt-5.4-mini": flat(0.75, 0, 0.075, 4.5),
  "gpt-5.3-codex": flat(1.75, 0, 0.175, 14),
  "gpt-5.2": flat(1.75, 0, 0.175, 14),
  "gpt-5.1": flat(1.25, 0, 0.125, 10),
  "gpt-5": flat(1.25, 0, 0.125, 10),
  // Not in Pi's catalog; OpenAI prices it like gpt-5. Older Codex sessions use it.
  "gpt-5-codex": flat(1.25, 0, 0.125, 10),
  "gpt-5-mini": flat(0.25, 0, 0.025, 2),
};

/** Prices that could not be confirmed in a second source. Empty means every row is checked. */
export const PRICE_NOTES: Readonly<Record<string, string>> = {};
