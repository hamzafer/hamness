import { h, s } from "./dom.ts";

export interface AreaChartOptions {
  /** Bucket starts (ms) and values, in time order. */
  points: { start: number; value: number }[];
  /** What the values are, e.g. "Cost". Names the chart for screen readers. */
  label: string;
  format: (v: number) => string;
  /** A shorter value format for the y-axis on narrow widths ($2k). Default: `format`. */
  compact?: (v: number) => string;
  /** Short tick label for a bucket start. */
  tick: (start: number) => string;
  /** Long label for the tooltip. */
  title: (start: number) => string;
  /** The last bucket is still filling: its segment is drawn dashed. */
  partialLast: boolean;
}

let gradientIds = 0;

/** A round axis top: 1, 2, 2.5 or 5 times a power of ten, at least `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

/** The y-axis steps, as fractions of the top. */
const STEPS = [0, 0.25, 0.5, 0.75, 1];
/** A generous width of one 11px mono character, so a label never runs off the card. */
const CHAR_PX = 7;

/**
 * The y-axis labels and the left gutter that fits them: compact labels on narrow widths, and
 * a gutter sized to the longest label, so `$2,000.00` is never cut at the card's edge.
 */
export function yAxis(
  top: number,
  opts: { format: (v: number) => string; compact?: (v: number) => string; narrow: boolean },
): { labels: string[]; left: number } {
  const fmt = opts.narrow && opts.compact ? opts.compact : opts.format;
  const labels = STEPS.map((f) => fmt(top * f));
  const longest = Math.max(...labels.map((l) => l.length));
  return { labels, left: Math.max(opts.narrow ? 40 : 48, Math.ceil(longest * CHAR_PX) + 12) };
}

/**
 * One series over time as a soft area with a 2px line, recessive grid, a crosshair and
 * tooltip on hover, and arrow-key stepping when focused. Redraws on resize.
 */
export function areaChart(opts: AreaChartOptions): HTMLElement {
  const root = h("div", { class: "chart" });
  const tip = h("div", { class: "chart-tip", role: "status", "aria-live": "polite", hidden: true });
  root.append(tip);
  const gid = `area-${++gradientIds}`;
  let active: number | null = null;
  let svgEl: SVGSVGElement | null = null;

  const draw = () => {
    const width = Math.max(280, Math.round(root.clientWidth || 640));
    const narrow = width < 520;
    const height = narrow ? 200 : 260;
    const n = opts.points.length;
    const top = niceMax(Math.max(0, ...opts.points.map((p) => p.value)));
    const axis = yAxis(top, {
      format: opts.format,
      ...(opts.compact ? { compact: opts.compact } : {}),
      narrow,
    });
    const pad = { top: 12, right: 12, bottom: 28, left: axis.left };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v: number) => pad.top + innerH - (v / top) * innerH;

    const grid = STEPS.map((f, i) => {
      const v = top * f;
      return s(
        "g",
        { class: "grid" },
        s("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }),
        s(
          "text",
          { x: pad.left - 8, y: y(v), dy: "0.32em", "text-anchor": "end" },
          axis.labels[i] ?? "",
        ),
      );
    });

    const tickEvery = Math.max(1, Math.ceil(n / (narrow ? 4 : 7)));
    const ticks = opts.points
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => (n - 1 - i) % tickEvery === 0)
      .map(({ p, i }) =>
        s(
          "text",
          { class: "tick", x: x(i), y: height - 8, "text-anchor": "middle" },
          opts.tick(p.start),
        ),
      );

    const coords = opts.points.map((p, i) => [x(i), y(p.value)] as const);
    const solid = opts.partialLast && n > 1 ? coords.slice(0, -1) : coords;
    const linePath = (cs: readonly (readonly [number, number])[]) =>
      cs.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const base = y(0);
    const area =
      coords.length > 0
        ? `${linePath(coords)}L${coords.at(-1)?.[0].toFixed(1)},${base}L${coords[0]?.[0].toFixed(1)},${base}Z`
        : "";

    const cross = s("line", {
      class: "crosshair",
      y1: pad.top,
      y2: pad.top + innerH,
      visibility: "hidden",
    });
    const dot = s("circle", { class: "dot", r: 4.5, visibility: "hidden" });

    const svg = s(
      "svg",
      {
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: "img",
        tabindex: 0,
        "aria-label": `${opts.label} over time. Use the arrow keys to read each point.`,
      },
      s(
        "defs",
        {},
        s(
          "linearGradient",
          { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 },
          s("stop", { offset: "0%", class: "area-stop-top" }),
          s("stop", { offset: "100%", class: "area-stop-bottom" }),
        ),
      ),
      ...grid,
      s("path", { class: "area", d: area, fill: `url(#${gid})` }),
      s("path", { class: "line", d: linePath(solid) }),
      opts.partialLast && n > 1
        ? s("path", { class: "line partial", d: linePath(coords.slice(-2)) })
        : null,
      ...ticks,
      cross,
      dot,
    );

    const show = (i: number | null) => {
      active = i;
      const p = i === null ? undefined : opts.points[i];
      if (i === null || !p) {
        cross.setAttribute("visibility", "hidden");
        dot.setAttribute("visibility", "hidden");
        tip.hidden = true;
        return;
      }
      const px = x(i);
      const py = y(p.value);
      cross.setAttribute("x1", String(px));
      cross.setAttribute("x2", String(px));
      cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", String(px));
      dot.setAttribute("cy", String(py));
      dot.setAttribute("visibility", "visible");
      const partial = opts.partialLast && i === n - 1 ? " (so far)" : "";
      tip.replaceChildren(
        h("div", { class: "tip-title" }, opts.title(p.start), partial),
        h("div", { class: "tip-value" }, `${opts.label}: `, h("strong", {}, opts.format(p.value))),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, px - tw / 2), width - tw)}px`;
      tip.style.top = `${Math.max(0, py - tip.offsetHeight - 14)}px`;
    };

    svg.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * width;
      const i = n <= 1 ? 0 : Math.round(((px - pad.left) / innerW) * (n - 1));
      show(Math.min(n - 1, Math.max(0, i)));
    });
    svg.addEventListener("pointerleave", () => show(null));
    svg.addEventListener("blur", () => show(null));
    svg.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const step = ev.key === "ArrowRight" ? 1 : -1;
        show(Math.min(n - 1, Math.max(0, (active ?? (step > 0 ? -1 : n)) + step)));
      } else if (ev.key === "Escape") show(null);
    });

    if (svgEl) svgEl.replaceWith(svg);
    else root.prepend(svg);
    svgEl = svg;
    if (active !== null) show(active);
  };

  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = Math.round(root.clientWidth);
    if (w && w !== lastWidth) {
      lastWidth = w;
      draw();
    }
  }).observe(root);
  queueMicrotask(draw);
  return root;
}
