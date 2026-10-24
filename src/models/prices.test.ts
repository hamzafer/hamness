import { describe, expect, test } from "bun:test";
import { costMicros, estimateCostMicros, priceFor } from "./prices.ts";

describe("priceFor", () => {
  test("finds a Claude model and ignores Claude Code's [1m] suffix", () => {
    expect(priceFor("claude-opus-5-5[1m]")).toEqual(priceFor("claude-opus-5-5"));
    expect(priceFor("claude-opus-5-5")?.input).toBe(4);
  });

  test("ignores a dated snapshot suffix", () => {
    expect(priceFor("claude-haiku-4-5-20251001")?.output).toBe(5);
  });

  test("returns undefined for an unknown or synthetic model", () => {
    expect(priceFor("<synthetic>")).toBeUndefined();
    expect(priceFor("some-local-model")).toBeUndefined();
  });
});

describe("estimateCostMicros", () => {
  test("prices each token kind per million tokens", () => {
    // claude-sonnet-4-5: in 3, out 15, cache read 0.3, cache write 3.75 USD / MTok
    const cost = estimateCostMicros("claude-sonnet-4-5", {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
    });
    // 3 + 1.5 + 0.3 = 4.8 USD
    expect(cost).toBe(4_800_000);
  });

  test("uses the higher tier once the prompt passes its threshold", () => {
    // gpt-5.5: 5 in / 30 out below 272k prompt tokens, 10 / 45 above
    const small = estimateCostMicros("gpt-5.5", {
      input: 100_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const big = estimateCostMicros("gpt-5.5", {
      input: 300_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(small).toBe(500_000);
    expect(big).toBe(3_000_000);
  });

  test("is 0 for a model without a price", () => {
    expect(
      estimateCostMicros("unknown", { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }),
    ).toBe(0);
  });
});

describe("costMicros", () => {
  const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
  });

  test("Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per million tokens", () => {
    // 100*4 + 20*20 + 5*0.2 + 7*5 = 836 micro-dollars
    expect(costMicros("claude-opus-5-5", usage(100, 20, 5, 7))).toBe(836);
  });

  test("rounds to whole micro-dollars", () => {
    // 3 and 7 tokens at $0.10/MTok are 0.3 and 0.7 micro-dollars
    expect(costMicros("claude-haiku-5-5", usage(3, 0))).toBe(0);
    expect(costMicros("claude-haiku-5-5", usage(7, 0))).toBe(1);
  });

  test("Haiku 5.5 bills a prompt over 100K tokens at the higher tier", () => {
    // 150K input at $0.50/MTok = $0.075; 1K output at $2.50/MTok = $0.0025
    expect(costMicros("claude-haiku-5-5", usage(150_000, 1_000))).toBe(77_500);
  });

  test("accepts a provider-prefixed id", () => {
    expect(costMicros("anthropic/claude-opus-5-5", usage(1_000_000, 0))).toBe(4_000_000);
  });

  test("is undefined, not 0, for a model without a price", () => {
    expect(costMicros("some-local-model", usage(1000, 1000))).toBeUndefined();
    expect(costMicros("constructor", usage(1, 1))).toBeUndefined();
  });
});
