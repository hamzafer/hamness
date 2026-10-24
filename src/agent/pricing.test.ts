import { describe, expect, test } from "bun:test";
import { costMicros, priceFor } from "./pricing.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe("costMicros", () => {
  test("Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per million tokens", () => {
    // 100*4 + 20*20 + 5*0.2 + 7*5 = 836 micro-dollars
    expect(costMicros("claude-opus-5-5", usage(100, 20, 5, 7))).toBe(836);
  });

  test("one million output tokens on Sonnet 5.5 cost $10", () => {
    expect(costMicros("claude-sonnet-5-5", usage(0, 1_000_000))).toBe(10_000_000);
  });

  test("rounds to whole micro-dollars", () => {
    // 3 tokens * $0.10/M = 0.3 micro-dollars
    expect(costMicros("claude-haiku-5-5", usage(3, 0))).toBe(0);
    expect(costMicros("claude-haiku-5-5", usage(7, 0))).toBe(1);
  });

  test("Haiku 5.5 bills a prompt over 100K tokens at the higher tier", () => {
    // 150K input at $0.50/M = $0.075; 1K output at $2.50/M = $0.0025
    expect(costMicros("claude-haiku-5-5", usage(150_000, 1_000))).toBe(77_500);
  });

  test("accepts a provider-prefixed id", () => {
    expect(costMicros("anthropic/claude-opus-5-5", usage(1_000_000, 0))).toBe(4_000_000);
  });

  test("an unknown model has no price", () => {
    expect(priceFor("gpt-6-astra")).toBeUndefined();
    expect(costMicros("gpt-6-astra", usage(1000, 1000))).toBeUndefined();
  });
});
