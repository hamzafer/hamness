/**
 * A thinking orb on a canvas, for the page. Every orb shares one clock (`orb-clock.ts`) and one
 * ink read from the theme tokens, refreshed when the system theme or the toggle changes.
 */
import { type OrbSize, type OrbState, orbFrame, staticOrbFrame } from "../../orbs/index.ts";
import { h } from "./dom.ts";
import { OrbClock, onScreenChange } from "./orb-clock.ts";
import { backing, type Ink, paintOrb, parseColor } from "./orb-paint.ts";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const clock = new OrbClock({
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  hidden: () => document.hidden,
  reducedMotion: () => reduced.matches,
});

function readInk(): Ink {
  const css = getComputedStyle(document.documentElement);
  return {
    fg: parseColor(css.getPropertyValue("--text")) ?? [11, 11, 11],
    bg: parseColor(css.getPropertyValue("--bg")) ?? [250, 250, 250],
  };
}

let ink = readInk();
const retheme = () => {
  ink = readInk();
  clock.repaint();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
new MutationObserver(retheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
document.addEventListener("visibilitychange", () => clock.wake());
reduced.addEventListener("change", () => clock.repaint());

const seen = new WeakMap<Element, Orb>();
const onScreen =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const orb = seen.get(e.target);
          if (!orb) continue;
          const change = onScreenChange({
            intersecting: e.isIntersecting,
            connected: e.target.isConnected,
            inClock: clock.has(orb),
          });
          if (change === "drop") {
            clock.remove(orb);
            seen.delete(e.target);
            onScreen?.unobserve(e.target);
          } else if (change === "add") clock.add(orb);
          else clock.setVisible(orb, change === "show");
        }
      })
    : undefined;

class Orb {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private box: { size: number; scale: number };
  private last: number | null = null;

  constructor(
    private size: OrbSize,
    private state: OrbState,
  ) {
    const { px, scale } = backing(size, window.devicePixelRatio);
    this.box = { size, scale };
    this.canvas = h("canvas", {
      class: "orb",
      width: px,
      height: px,
      "aria-hidden": "true",
      "data-orb-state": state,
    });
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext("2d");
  }

  get connected(): boolean {
    return this.canvas.isConnected;
  }

  draw(seconds: number | null): void {
    this.last = seconds;
    if (!this.ctx) return;
    const frame =
      seconds === null
        ? staticOrbFrame(this.state, this.size)
        : orbFrame(this.state, this.size, seconds);
    paintOrb(this.ctx, frame, ink, this.box);
  }

  setState(state: OrbState): void {
    if (state === this.state) return;
    this.state = state;
    this.canvas.dataset.orbState = state;
    this.draw(this.last);
  }
}

export interface OrbHandle {
  readonly el: HTMLCanvasElement;
  setState(state: OrbState): void;
}

/** A live orb; it joins the shared clock once it is on screen. */
export function orb(state: OrbState, size: OrbSize = 20): OrbHandle {
  const o = new Orb(size, state);
  seen.set(o.canvas, o);
  if (onScreen) onScreen.observe(o.canvas);
  else queueMicrotask(() => clock.add(o));
  return { el: o.canvas, setState: (s) => o.setState(s) };
}
