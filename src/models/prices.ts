/**
 * A minimal model price table for estimating the cost of imported history.
 *
 * Prices are USD per million tokens, copied from Pi's model catalog
 * (`@earendil-works/pi-ai`). When hamness depends on Pi, replace this table
 * with `getModel(provider, id).cost` and keep `estimateCostMicros`.
 */

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice extends Price {
  /** Higher prices that apply per request once the prompt passes `inputTokensAbove`. */
  tiers?: readonly (Price & { inputTokensAbove: number })[];
}

export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead: number, cacheWrite: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const above = (inputTokensAbove: number, price: Price) => ({ inputTokensAbove, ...price });

const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-fable-5": p(10, 50, 1, 12.5),
  "claude-fable-5-1": p(10, 50, 0.25, 12.5),
  "claude-opus-5-5": p(4, 20, 0.2, 5),
  "claude-opus-5": p(5, 25, 0.5, 6.25),
  "claude-opus-4-8": p(5, 25, 0.5, 6.25),
  "claude-opus-4-7": p(5, 25, 0.5, 6.25),
  "claude-opus-4-6": p(5, 25, 0.5, 6.25),
  "claude-opus-4-5": p(5, 25, 0.5, 6.25),
  "claude-sonnet-5-5": p(2, 10, 0.1, 2.5),
  "claude-sonnet-5": p(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": p(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": p(3, 15, 0.3, 3.75),
  "claude-haiku-5-5": {
    ...p(0.1, 0.5, 0.01, 0.125),
    tiers: [above(100_000, p(0.5, 2.5, 0.05, 0.625))],
  },
  "claude-haiku-4-5": p(1, 5, 0.1, 1.25),
  // OpenAI
  "gpt-6.1-sol": { ...p(2, 10, 0.1, 2.5), tiers: [above(272_000, p(4, 15, 0.2, 5))] },
  "gpt-6-sol": { ...p(2, 10, 0.2, 2.5), tiers: [above(272_000, p(4, 15, 0.4, 5))] },
  "gpt-6-astra": { ...p(10, 50, 1, 12.5), tiers: [above(272_000, p(20, 75, 2, 25))] },
  "gpt-6-luna": { ...p(0.1, 0.5, 0.01, 0.125), tiers: [above(272_000, p(0.2, 0.75, 0.02, 0.25))] },
  "gpt-5.6-sol": { ...p(4, 20, 0.4, 5), tiers: [above(272_000, p(8, 30, 0.8, 10))] },
  "gpt-5.6-terra": { ...p(2, 12, 0.2, 2.5), tiers: [above(272_000, p(4, 18, 0.4, 5))] },
  "gpt-5.6-luna": { ...p(0.2, 1.2, 0.02, 0.25), tiers: [above(272_000, p(0.4, 1.8, 0.04, 0.5))] },
  "gpt-5.5": { ...p(5, 30, 0.5, 0), tiers: [above(272_000, p(10, 45, 1, 0))] },
  "gpt-5.4": { ...p(2.5, 15, 0.25, 0), tiers: [above(272_000, p(5, 22.5, 0.5, 0))] },
  "gpt-5.4-mini": p(0.75, 4.5, 0.075, 0),
  "gpt-5.3-codex": p(1.75, 14, 0.175, 0),
  "gpt-5.2": p(1.75, 14, 0.175, 0),
  "gpt-5.1": p(1.25, 10, 0.125, 0),
  "gpt-5": p(1.25, 10, 0.125, 0),
  // Not in Pi's catalog; OpenAI prices it like gpt-5. Older Codex sessions use it.
  "gpt-5-codex": p(1.25, 10, 0.125, 0),
  "gpt-5-mini": p(0.25, 2, 0.025, 0),
};

/** Strips Claude Code's context suffix (`[1m]`) and a dated snapshot suffix (`-20251001`). */
function normalize(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[normalize(model)];
}

/** Estimated cost of one model call in micro-dollars. 0 when the model has no price. */
export function estimateCostMicros(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  if (!price) return 0;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  let rate: Price = price;
  for (const tier of price.tiers ?? []) if (prompt > tier.inputTokensAbove) rate = tier;
  // USD per MTok times tokens is micro-dollars directly.
  return Math.round(
    usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheRead * rate.cacheRead +
      usage.cacheWrite * rate.cacheWrite,
  );
}
