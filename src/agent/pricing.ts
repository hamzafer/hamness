/**
 * What Claude models cost, in US dollars per million tokens (which is also micro-dollars per token).
 *
 * Sources, checked 2026-10-24:
 * - Anthropic's published model table and prompt-caching docs (input, output, cache read;
 *   5-minute cache writes cost 1.25x input).
 * - Pi's model catalog (`@earendil-works/pi-ai` 1.4.0, `providers/data/anthropic.json`).
 * Where the two agree the price is `verified`. Where they disagree or only one lists it, the
 * entry says so in `note` and we use Anthropic's figure.
 *
 * Not modeled yet (ticket #13): 1-hour cache writes (2x input), batch and fast-mode pricing,
 * non-Claude providers. A model missing here has no price; callers fall back to Pi's own cost.
 */

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice extends Rates {
  verified: boolean;
  note?: string;
  /** Higher rates for a prompt (input + cache read + cache write) above this many tokens. */
  tier?: { promptTokensAbove: number } & Rates;
}

const rates = (input: number, output: number, cacheRead: number, cacheWrite: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

export const CLAUDE_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { ...rates(10, 50, 0.25, 12.5), verified: true },
  "claude-fable-5": { ...rates(10, 50, 1, 12.5), verified: true },
  "claude-opus-5-5": { ...rates(4, 20, 0.2, 5), verified: true },
  "claude-opus-5": { ...rates(5, 25, 0.5, 6.25), verified: true },
  "claude-opus-4-8": { ...rates(5, 25, 0.5, 6.25), verified: true },
  "claude-opus-4-7": { ...rates(5, 25, 0.5, 6.25), verified: true },
  "claude-opus-4-6": { ...rates(5, 25, 0.5, 6.25), verified: true },
  "claude-sonnet-5-5": {
    ...rates(2, 10, 0.2, 2.5),
    verified: false,
    note: "cache read: Anthropic's docs say $0.20, Pi's catalog says $0.10",
  },
  "claude-sonnet-5": { ...rates(2, 10, 0.2, 2.5), verified: true },
  "claude-sonnet-4-6": { ...rates(3, 15, 0.3, 3.75), verified: true },
  "claude-haiku-5-5": {
    ...rates(0.1, 0.5, 0.01, 0.125),
    verified: false,
    note: "tier input/output from both sources; tier cache rates from Pi's catalog only",
    tier: { promptTokensAbove: 100_000, ...rates(0.5, 2.5, 0.05, 0.625) },
  },
  "claude-haiku-4-5": { ...rates(1, 5, 0.1, 1.25), verified: true },
};

/** The price for a model id, with or without a `provider/` prefix. */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return Object.hasOwn(CLAUDE_PRICES, id) ? CLAUDE_PRICES[id] : undefined;
}

/** Cost of one model call in whole micro-dollars, or undefined when the model has no price. */
export function costMicros(model: string, usage: TokenUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const r: Rates = price.tier && prompt > price.tier.promptTokensAbove ? price.tier : price;
  return Math.round(
    usage.input * r.input +
      usage.output * r.output +
      usage.cacheRead * r.cacheRead +
      usage.cacheWrite * r.cacheWrite,
  );
}
