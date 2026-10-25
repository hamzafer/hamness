import { describe, expect, test } from "bun:test";
import { backing, inkFill, paintOrb, parseColor } from "./orb-paint.ts";

describe("orb ink", () => {
  test("reads the theme's colors as rgb", () => {
    expect(parseColor("#fafafa")).toEqual([250, 250, 250]);
    expect(parseColor(" #0b0b0b ")).toEqual([11, 11, 11]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(240, 239, 236)")).toEqual([240, 239, 236]);
    expect(parseColor("rgba(1,2,3,0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("teal")).toBeUndefined();
  });

  test("near dots take the text color, far dots fade toward the background", () => {
    const ink = { bg: [250, 250, 250] as const, fg: [10, 10, 10] as const };
    expect(inkFill(ink, 0, 1)).toBe("rgba(10,10,10,1)");
    expect(inkFill(ink, 1, 0.5)).toBe("rgba(250,250,250,0.5)");
    expect(inkFill(ink, 0.5, 1)).toBe("rgba(130,130,130,1)");
  });

  test("the backing store follows the device pixel ratio, capped at 2", () => {
    expect(backing(20, 1)).toEqual({ px: 20, scale: 1 });
    expect(backing(20, 1.5)).toEqual({ px: 30, scale: 1.5 });
    expect(backing(64, 3)).toEqual({ px: 128, scale: 2 });
    expect(backing(20, 0)).toEqual({ px: 20, scale: 1 });
    expect(backing(20, Number.NaN)).toEqual({ px: 20, scale: 1 });
  });
});

describe("orb painter", () => {
  test("arcs only, far to near, skipping invisible dots and flooring radii", () => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: "" as unknown,
      setTransform: (a: number, _b: number, _c: number, d: number) => calls.push(`scale ${a},${d}`),
      clearRect: (_x: number, _y: number, w: number, h: number) => calls.push(`clear ${w}x${h}`),
      beginPath() {},
      arc: (x: number, y: number, r: number) => calls.push(`arc ${x},${y},${r} ${ctx.fillStyle}`),
      fill() {},
    };
    paintOrb(
      ctx,
      {
        rMin: 0.5,
        dots: [
          { x: 1, y: 1, z: -1, r: 1, white: 0, a: 0.01 },
          { x: 2, y: 3, z: 0, r: 0.1, white: 0 },
          { x: 4, y: 5, z: 1, r: 2, white: 1, a: 0.5 },
        ],
      },
      { bg: [255, 255, 255], fg: [0, 0, 0] },
      { size: 20, scale: 2 },
    );
    expect(calls).toEqual([
      "scale 2,2",
      "clear 20x20",
      "arc 2,3,0.5 rgba(0,0,0,1)",
      "arc 4,5,2 rgba(255,255,255,0.5)",
    ]);
  });
});
