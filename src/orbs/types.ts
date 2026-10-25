// Vendored from thinking-orbs (https://github.com/RareFormLabs/thinking-orbs, e09bfa6),
// MIT License, Copyright (c) 2026 Jakub Antalik. See ./LICENSE.
//
// Engine-level contracts shared by every mode implementation.

import type { Dot } from "./core.ts";
import type { ModeOpts } from "./profiles.ts";

export type { Dot } from "./core.ts";

/**
 * One frame of a mode at CSS-px `size` and mode time `t`. Upstream's `ModeDraw` painted a
 * 2D context; this returns the dots unsorted and the caller paints them.
 */
export type ModeFrame = (size: number, t: number, opts: ModeOpts) => Dot[];

/**
 * The six shipped states, each a hand-tuned animation:
 * - `working`: particles on tilted orbits
 * - `searching`: a scan meridian sweeps a dotted globe
 * - `solving`: bands scramble in quarter turns, then click back
 * - `listening`: a waveform rolls through latitude rings
 * - `composing`: an undulating multi-band sash
 * - `shaping`: a dotted outline morphs circle → triangle → square
 */
export type OrbState = "working" | "searching" | "solving" | "listening" | "composing" | "shaping";

/**
 * Size in CSS pixels. Exactly two tuned presets ship: 64 (chat-avatar scale) and 20
 * (inline-text scale). Each carries its own dot count, dot size and speed tuning.
 */
export type OrbSize = 64 | 20;
