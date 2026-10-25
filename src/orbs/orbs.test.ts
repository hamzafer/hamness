import { describe, expect, test } from "bun:test";
import {
  ORB_SIZES,
  ORB_STATES,
  orbFrame,
  resolvePreset,
  STATIC_TIME,
  staticOrbFrame,
} from "./index.ts";

describe("thinking orbs engine", () => {
  test("every state and size draws finite dots inside its frame, sorted far to near", () => {
    for (const state of ORB_STATES) {
      for (const size of ORB_SIZES) {
        const { dots } = orbFrame(state, size, 1.25);
        expect(dots.length).toBeGreaterThan(5);
        for (const d of dots) {
          expect(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.r)).toBe(true);
          expect(d.x).toBeGreaterThan(-1);
          expect(d.x).toBeLessThan(size + 1);
          expect(d.y).toBeGreaterThan(-1);
          expect(d.y).toBeLessThan(size + 1);
        }
        for (let i = 1; i < dots.length; i++) {
          expect((dots[i]?.z ?? 0) >= (dots[i - 1]?.z ?? 0)).toBe(true);
        }
      }
    }
  });

  test("a frame depends only on its inputs, and moves with time", () => {
    for (const state of ORB_STATES) {
      expect(orbFrame(state, 64, 2)).toEqual(orbFrame(state, 64, 2));
      expect(orbFrame(state, 20, 2)).not.toEqual(orbFrame(state, 20, 2.3));
    }
  });

  test("presets scale the base profiles like upstream does", () => {
    // globe at 20px: count 0.105 → each side of the lattice by √0.105
    expect(resolvePreset("searching", 20).opts).toMatchObject({
      latRings: 6,
      lonDensity: 14,
      scanMul: 4.335,
      dimBase: 0.45,
    });
    expect(resolvePreset("working", 64)).toMatchObject({ mode: "orbits", speed: 1.885 });
    expect(resolvePreset("shaping", 64).opts.rSizeMul).toBeCloseTo(0.395);
  });

  test("dot counts at fixed times", () => {
    // 12 orbits × (40 ghost dots + 3 particles)
    expect(orbFrame("working", 64, 0).dots).toHaveLength(12 * 43);
    // morph: max(6, round(34 × 0.54)) dots on the outline
    expect(orbFrame("shaping", 64, 0).dots).toHaveLength(18);
  });

  test("golden frame: the nearest working dot at t = 1s", () => {
    const { dots } = orbFrame("working", 64, 1);
    const near = dots.at(-1);
    expect(near?.x).toBeCloseTo(31.5996, 3);
    expect(near?.y).toBeCloseTo(32.2889, 3);
    expect(near?.z).toBeCloseTo(24.1677, 3);
  });

  test("the static frame is upstream's reduced-motion frame (mode time 0.6s)", () => {
    expect(STATIC_TIME).toBe(0.6);
    for (const state of ORB_STATES) {
      expect(staticOrbFrame(state, 20)).toEqual(staticOrbFrame(state, 20));
      expect(staticOrbFrame(state, 20).dots.length).toBeGreaterThan(5);
    }
  });
});
