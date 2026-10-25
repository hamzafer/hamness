// Vendored from thinking-orbs (https://github.com/RareFormLabs/thinking-orbs, e09bfa6),
// MIT License, Copyright (c) 2026 Jakub Antalik. See ./LICENSE.
//
// Painter: matte grayscale dots, far → near (an `orbFrame` is already
// sorted). Plain 2D canvas fills only: no ctx.filter, no SVG filters, so
// every mode renders identically in Chrome, Safari and Firefox.

import { inkGray, type OrbFrame } from "./index.ts";

/** The slice of `CanvasRenderingContext2D` the painter uses (no DOM types outside the page). */
export interface PaintTarget {
  fillStyle: unknown;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
}

export function paint(ctx: PaintTarget, frame: OrbFrame, dark: boolean): void {
  for (const d of frame.dots) {
    const alpha = d.a ?? 1;
    if (alpha < 0.02) continue;
    const g = inkGray(d.white, dark);
    ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(frame.rMin, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}
