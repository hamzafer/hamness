import { type Dot, inkGray, type OrbFrame } from "./index.ts";

/**
 * An orb frame as braille text: each terminal cell holds a 2 × 4 grid of dots (U+2800 block),
 * and terminal cells are about twice as tall as wide, so a braille dot is close to square and
 * `cols = 2 × rows` keeps the orb round.
 */
export interface BrailleOrb {
  /** One string per terminal row, `cols` characters each. */
  lines: string[];
  /** Per cell, the brightest lit dot's ink (0..1); 0 for an empty cell. Picks the fg shade. */
  levels: number[][];
}

/** Bit of each dot in a braille cell, by [row][col]. */
const BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;
const BLANK = 0x2800;

export interface BrailleOpts {
  /** A dot shows when its ink reaches this (0..1). */
  threshold?: number;
}

/**
 * Paints `frame` (a `size` px square) onto a `cols` × `rows` braille grid the way upstream's
 * canvas painter does: far dots first, each blended over what is under it by its alpha. Then a
 * grid dot shows when its ink reaches `threshold`.
 */
export function brailleOrb(
  frame: OrbFrame,
  size: number,
  cols: number,
  rows: number,
  opts: BrailleOpts = {},
): BrailleOrb {
  const threshold = opts.threshold ?? 0.4;
  const w = cols * 2;
  const h = rows * 4;
  const scale = Math.min(w, h) / size;
  const ox = (w - size * scale) / 2;
  const oy = (h - size * scale) / 2;
  const ink = new Float64Array(w * h);
  for (const d of frame.dots) splat(ink, w, h, d, scale, ox, oy, frame.rMin);

  const lines: string[] = [];
  const levels: number[][] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    const rowLevels: number[] = [];
    for (let col = 0; col < cols; col++) {
      let bits = 0;
      let level = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const v = ink[(row * 4 + dy) * w + col * 2 + dx] ?? 0;
          if (v < threshold) continue;
          bits |= BITS[dy]?.[dx] ?? 0;
          level = Math.max(level, v);
        }
      }
      line += String.fromCharCode(BLANK + bits);
      rowLevels.push(level);
    }
    lines.push(line);
    levels.push(rowLevels);
  }
  return { lines, levels };
}

function splat(
  ink: Float64Array,
  w: number,
  h: number,
  d: Dot,
  scale: number,
  ox: number,
  oy: number,
  rMin: number,
): void {
  const alpha = d.a ?? 1;
  if (alpha < 0.02) return;
  // How much ink: near dots carry more (a bright dot on a dark terminal, a dark one on light).
  const value = inkGray(d.white, true) / 255;
  const x = ox + d.x * scale;
  const y = oy + d.y * scale;
  const r = Math.max(rMin, d.r) * scale;
  // A grid dot is far bigger than most orb dots: a dot inks the grid dot it lands on, and a big
  // one every grid dot its disc reaches.
  const reach = Math.max(0, Math.ceil(r - 0.5));
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  for (let py = cy - reach; py <= cy + reach; py++) {
    if (py < 0 || py >= h) continue;
    for (let px = cx - reach; px <= cx + reach; px++) {
      if (px < 0 || px >= w) continue;
      const dist = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (dist > r && (px !== cx || py !== cy)) continue;
      const i = py * w + px;
      ink[i] = (ink[i] ?? 0) * (1 - alpha) + value * alpha;
    }
  }
}
