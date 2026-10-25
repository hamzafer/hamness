import { describe, expect, test } from "bun:test";
import { money, moneyCompact } from "../stats/format.ts";
import { yAxis } from "./client/chart.ts";

describe("moneyCompact: short dollar labels for narrow axes", () => {
  test("thousands and millions shorten, small amounts keep their cents", () => {
    expect(moneyCompact(2_000_000_000)).toBe("$2k");
    expect(moneyCompact(2_500_000_000)).toBe("$2.5k");
    expect(moneyCompact(1_250_000_000_000)).toBe("$1.3M");
    expect(moneyCompact(750_000_000)).toBe("$750");
    expect(moneyCompact(7_500_000)).toBe("$7.50");
    expect(moneyCompact(0)).toBe("$0");
  });
});

describe("yAxis: labels always fit left of the plot", () => {
  const top = 2_000_000_000; // $2,000.00

  test("narrow: compact labels, and the gutter fits the longest one", () => {
    const axis = yAxis(top, { format: money, compact: moneyCompact, narrow: true });
    expect(axis.labels).toEqual(["$0", "$500", "$1k", "$1.5k", "$2k"]);
    expect(axis.left).toBeGreaterThanOrEqual(Math.ceil("$1.5k".length * 7) + 8);
  });

  test("wide: full labels, with a gutter wide enough for $2,000.00", () => {
    const axis = yAxis(top, { format: money, narrow: false });
    expect(axis.labels.at(-1)).toBe("$2,000.00");
    expect(axis.left).toBeGreaterThanOrEqual(Math.ceil("$2,000.00".length * 7) + 8);
  });
});
