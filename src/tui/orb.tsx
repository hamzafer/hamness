import { Index } from "solid-js";
import { brailleOrb } from "../orbs/braille.ts";
import { type OrbState, orbFrame, staticOrbFrame } from "../orbs/index.ts";

/** The small (20px) preset in 4 × 2 cells: 8 × 8 braille dots, about square on screen. */
export const ORB_COLS = 4;
export const ORB_ROWS = 2;
const ORB_SIZE = 20;

/** Frame rate while something runs; nothing ticks when idle. */
export const ORB_FPS = 12;

/** Dim, mid and bright ink for a cell, by its brightest dot. */
const SHADES = ["#565f89", "#7aa2f7", "#c0caf5"] as const;

function shade(level: number): string {
  if (level >= 0.75) return SHADES[2];
  if (level >= 0.55) return SHADES[1];
  return SHADES[0];
}

/** `HAMNESS_NO_ANIMATION=1`: orbs show one still frame (the terminal has no reduced-motion setting). */
export function animationOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.HAMNESS_NO_ANIMATION === "1";
}

export interface OrbProps {
  state: OrbState;
  /** Seconds into the animation; without it the orb is one still frame. */
  seconds?: number | undefined;
}

/** A thinking orb drawn in braille, `ORB_COLS` × `ORB_ROWS` cells. */
export function Orb(props: OrbProps) {
  const cells = () => {
    const frame =
      props.seconds === undefined
        ? staticOrbFrame(props.state, ORB_SIZE)
        : orbFrame(props.state, ORB_SIZE, props.seconds);
    const { lines, levels } = brailleOrb(frame, ORB_SIZE, ORB_COLS, ORB_ROWS);
    return lines.map((line, row) =>
      [...line].map((ch, col) => ({ ch, fg: shade(levels[row]?.[col] ?? 0) })),
    );
  };
  return (
    <box flexDirection="column" width={ORB_COLS} height={ORB_ROWS} flexShrink={0}>
      {/* Index, not For: each frame updates the same cells instead of rebuilding them. */}
      <Index each={cells()}>
        {(row) => (
          <box flexDirection="row" height={1}>
            <Index each={row()}>{(cell) => <text fg={cell().fg}>{cell().ch}</text>}</Index>
          </box>
        )}
      </Index>
    </box>
  );
}
