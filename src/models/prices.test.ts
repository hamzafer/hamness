import { describe, expect, test } from "bun:test";
import { estimateCostMicros, priceFor } from "./prices.ts";

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
