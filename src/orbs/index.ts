// Thinking orbs: animated dotted spheres that show what an agent is doing. The math is
// vendored from thinking-orbs (https://github.com/RareFormLabs/thinking-orbs, e09bfa6),
// MIT License, Copyright (c) 2026 Jakub Antalik (./LICENSE). Its Vue component and DOM theme
// hooks are left out: `orbFrame` returns plain dots, and each client draws them its own way
// (braille cells in the TUI, a canvas in the dashboard).

import { type Dot, zSort } from "./core.ts";
import { globeFrame, rubikFrame, waveFrame } from "./lattice.ts";
import { morphFrame } from "./morph.ts";
import { orbitsFrame } from "./orbits.ts";
import { type ModeKey, resolvePreset } from "./presets.ts";
import { ribbonFrame } from "./ribbon.ts";
import type { ModeFrame, OrbSize, OrbState } from "./types.ts";

export type { Dot } from "./core.ts";
export { inkGray } from "./core.ts";
export { resolvePreset } from "./presets.ts";
export type { OrbSize, OrbState } from "./types.ts";

export const ORB_STATES: readonly OrbState[] = [
  "working",
  "searching",
  "solving",
  "listening",
  "composing",
  "shaping",
];
export const ORB_SIZES: readonly OrbSize[] = [20, 64];

/** Upstream's reduced-motion frame: mode time 0.6s, before the preset's speed. */
export const STATIC_TIME = 0.6;

const MODE_FRAMES: Record<ModeKey, ModeFrame> = {
  orbits: orbitsFrame,
  globe: globeFrame,
  rubik: rubikFrame,
  wave: waveFrame,
  ribbon: ribbonFrame,
  morph: morphFrame,
};

export interface OrbFrame {
  /** Sorted far → near, in CSS px inside a `size` × `size` square. */
  dots: Dot[];
  /** The smallest radius worth painting. */
  rMin: number;
}

/** The frame at mode time `t` (already scaled by the preset's speed). */
export function modeFrame(state: OrbState, size: OrbSize, t: number): OrbFrame {
  const { mode, opts } = resolvePreset(state, size);
  return { dots: zSort(MODE_FRAMES[mode](size, t, opts)), rMin: opts.rMin ?? 0.3 };
}

/** The frame `seconds` into the animation, at the preset's tuned speed times `speed`. */
export function orbFrame(state: OrbState, size: OrbSize, seconds: number, speed = 1): OrbFrame {
  return modeFrame(state, size, seconds * resolvePreset(state, size).speed * speed);
}

/** One still frame, for reduced motion. */
export function staticOrbFrame(state: OrbState, size: OrbSize): OrbFrame {
  return modeFrame(state, size, STATIC_TIME);
}
