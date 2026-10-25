import { describe, expect, test } from "bun:test";
import { brailleOrb } from "./braille.ts";
import { ORB_STATES, orbFrame } from "./index.ts";

const BLANK = "⠀";
const isBraille = (ch: string) => ch >= "⠀" && ch <= "⣿";

describe("braille orb", () => {
  test("an empty frame is blank braille, cols × rows", () => {
    const out = brailleOrb({ dots: [], rMin: 0.3 }, 20, 4, 2);
    expect(out.lines).toEqual([BLANK.repeat(4), BLANK.repeat(4)]);
    expect(out.levels).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });

  test("one near dot lights the grid dot it lands on", () => {
    // 20px onto an 8 × 8 grid: (11, 1) lands on grid dot (4, 0), the top left of cell 2.
    const dot = { x: 11, y: 1, z: 0, r: 0.3, white: 0 };
    const out = brailleOrb({ dots: [dot], rMin: 0.3 }, 20, 4, 2);
    expect(out.lines[0]).toBe(`${BLANK}${BLANK}⠁${BLANK}`);
    expect(out.levels[0]?.[2]).toBe(1);
  });

  test("a faint far dot stays off; a near one drawn over it shows", () => {
    const far = { x: 2, y: 2, z: -1, r: 0.3, white: 0.9 };
    expect(brailleOrb({ dots: [far], rMin: 0.3 }, 20, 4, 2).lines[0]).toBe(BLANK.repeat(4));
    const near = { ...far, z: 1, white: 0.1 };
    const out = brailleOrb({ dots: [far, near], rMin: 0.3 }, 20, 4, 2);
    expect(out.lines[0]?.[0]).not.toBe(BLANK);
  });

  test("every state draws something at the small size", () => {
    for (const state of ORB_STATES) {
      const { lines } = brailleOrb(orbFrame(state, 20, 0.5), 20, 4, 2);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toHaveLength(4);
        expect([...line].every(isBraille)).toBe(true);
      }
      expect(lines.join("").replaceAll(BLANK, "").length).toBeGreaterThan(0);
    }
  });
});
