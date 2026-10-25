import { describe, expect, test } from "bun:test";
import { money, moneyCompact, planMoney } from "../stats/format.ts";
import { niceMax, yAxis } from "./client/chart.ts";

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

  const cost = (v: number) => money(Math.round(v));

  test("all-zero data: one $0 baseline, no repeated $0.00 ticks", () => {
    for (const narrow of [false, true]) {
      const axis = yAxis(niceMax(0), {
        format: cost,
        compact: (v) => moneyCompact(Math.round(v)),
        narrow,
        allZero: true,
      });
      expect(axis.labels).toEqual(["$0"]);
      expect(axis.steps).toEqual([0]);
    }
  });

  test("tiny values: every tick label is shown once", () => {
    // $0.003 at the top: the steps format as $0.00, <$0.01, <$0.01, <$0.01, $0.01.
    const axis = yAxis(niceMax(3_000), { format: cost, narrow: false });
    expect(new Set(axis.labels).size).toBe(axis.labels.length);
    expect(axis.labels).toEqual(["$0.00", "<$0.01", "$0.01"]);
    expect(axis.steps).toEqual([0, 0.25, 1]);
  });
});

describe("planMoney: plan spend reads $0 (plan), never a bare $0.00", () => {
  test("only plan calls: $0 (plan); paid spend: dollars; nothing: $0.00", () => {
    expect(planMoney(0, 3)).toBe("$0 (plan)");
    expect(planMoney(1_500_000, 3)).toBe("$1.50");
    expect(planMoney(0, 0)).toBe("$0.00");
  });
});
