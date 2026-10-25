import { describe, expect, test } from "bun:test";
import { paint } from "./paint.ts";

function recorder() {
  const arcs: Array<{ fill: string; x: number; y: number; r: number }> = [];
  const ctx = {
    fillStyle: "" as unknown,
    beginPath() {},
    arc(x: number, y: number, r: number) {
      arcs.push({ fill: String(ctx.fillStyle), x, y, r });
    },
    fill() {},
  };
  return { ctx, arcs };
}

describe("canvas painter", () => {
  const frame = {
    rMin: 0.5,
    dots: [
      { x: 1, y: 2, z: -1, r: 0.1, white: 0.2, a: 0.01 },
      { x: 3, y: 4, z: 0, r: 0.1, white: 0.2 },
      { x: 5, y: 6, z: 1, r: 2, white: 0.2, a: 0.5 },
    ],
  };

  test("skips invisible dots, floors radii at rMin, keeps the frame's order", () => {
    const { ctx, arcs } = recorder();
    paint(ctx, frame, false);
    expect(arcs.map((a) => [a.x, a.y, a.r])).toEqual([
      [3, 4, 0.5],
      [5, 6, 2],
    ]);
    expect(arcs[0]?.fill).toBe("rgba(51,51,51,1)");
  });

  test("dark mirrors the ink so near dots read bright", () => {
    const { ctx, arcs } = recorder();
    paint(ctx, frame, true);
    expect(arcs.map((a) => a.fill)).toEqual(["rgba(204,204,204,1)", "rgba(204,204,204,0.5)"]);
  });
});
