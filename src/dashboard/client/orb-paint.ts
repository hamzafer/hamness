/**
 * Paints an orb frame on a 2D canvas: plain arcs, far to near, in one ink. The ink is the
 * theme's own text color fading toward its background, so the orb follows light, dark and the
 * theme toggle without a color of its own.
 */
import type { OrbFrame } from "../../orbs/index.ts";

export type Rgb = readonly [number, number, number];

/** The theme's two ends: near dots take `fg`, far dots fade toward `bg`. */
export interface Ink {
  bg: Rgb;
  fg: Rgb;
}

/** `#rgb`, `#rrggbb` or `rgb()`/`rgba()`, as a computed style or a CSS token gives them. */
export function parseColor(css: string): Rgb | undefined {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return undefined;
}

/** A dot's fill: `white` 0 is full ink, 1 is the background (upstream's depth shading). */
export function inkFill(ink: Ink, white: number, alpha: number): string {
  const w = Math.min(1, Math.max(0, white));
  const c = ink.fg.map((f, i) => Math.round(f + ((ink.bg[i] ?? f) - f) * w));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Canvas pixels for a `size` CSS-px orb: sharp on retina, never more than 2x. */
export function backing(size: number, dpr: number): { px: number; scale: number } {
  const scale = Number.isFinite(dpr) && dpr > 0 ? Math.min(2, Math.max(1, dpr)) : 1;
  return { px: Math.round(size * scale), scale };
}

/** The slice of `CanvasRenderingContext2D` the painter needs. */
export interface OrbCanvas {
  fillStyle: unknown;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
}

export function paintOrb(
  ctx: OrbCanvas,
  frame: OrbFrame,
  ink: Ink,
  box: { size: number; scale: number },
): void {
  ctx.setTransform(box.scale, 0, 0, box.scale, 0, 0);
  ctx.clearRect(0, 0, box.size, box.size);
  for (const d of frame.dots) {
    const alpha = d.a ?? 1;
    if (alpha < 0.02) continue;
    ctx.fillStyle = inkFill(ink, d.white, alpha);
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(frame.rMin, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}
