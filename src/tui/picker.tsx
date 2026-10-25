import { useKeyboard } from "@opentui/solid";
import { createSignal, For } from "solid-js";

export const PICKER_COLORS = {
  text: "#c0caf5",
  muted: "#737aa2",
  dim: "#565f89",
  highlight: "#283457",
  accent: "#7aa2f7",
};

export interface PickerRow {
  /** Columns, aligned across rows; the first is the main one, the rest show muted. */
  cells: string[];
  /** Marked with ● (the session, level or mode in use now). */
  current?: boolean;
  /** Shown dimmed (can't be picked, e.g. a session whose file is gone). */
  dim?: boolean;
}

export interface PickerSpec {
  title: string;
  rows: PickerRow[];
  /** The row the highlight starts on. */
  start?: number;
  onPick: (index: number) => void;
}

/** Rows shown at once; the list scrolls to keep the highlight in view. */
export const PICKER_ROWS = 8;

/** Pads each column to its widest cell, so the rows line up. */
export function alignRows(rows: readonly PickerRow[], gap = 3): string[] {
  const widths: number[] = [];
  for (const r of rows) {
    r.cells.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  }
  return rows.map((r) =>
    r.cells
      .map((c, i) => (i === r.cells.length - 1 ? c : c.padEnd((widths[i] ?? 0) + gap)))
      .join(""),
  );
}

/** The first row on screen so that `selected` is visible in a window of `size`. */
export function windowStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, selected - Math.floor(size / 2)), total - size);
}

/**
 * A list to pick one row from (`/resume`, `/fork`, `/thinking`, `/mode`). Up/Down move,
 * Enter picks, Esc closes. It owns the keyboard while it shows.
 */
export function Picker(props: { spec: PickerSpec; onClose: () => void }) {
  const total = () => props.spec.rows.length;
  const [selected, setSelected] = createSignal(
    Math.min(Math.max(0, props.spec.start ?? 0), Math.max(0, total() - 1)),
  );
  useKeyboard((key) => {
    if (key.name === "escape") props.onClose();
    else if (key.name === "up" || (key.ctrl && key.name === "p"))
      setSelected((i) => (i - 1 + total()) % total());
    else if (key.name === "down" || (key.ctrl && key.name === "n"))
      setSelected((i) => (i + 1) % total());
    else if (key.name === "return" || key.name === "kpenter") {
      // Read before closing: the spec is gone once the picker unmounts.
      const { onPick } = props.spec;
      const i = selected();
      props.onClose();
      onPick(i);
    }
  });
  const lines = () => alignRows(props.spec.rows);
  const visible = () => {
    const from = windowStart(selected(), total(), PICKER_ROWS);
    return lines()
      .slice(from, from + PICKER_ROWS)
      .map((text, k) => ({ text, index: from + k }));
  };
  const more = () => (total() > PICKER_ROWS ? `  ${selected() + 1}/${total()}` : "");
  return (
    <box
      border
      borderColor={PICKER_COLORS.dim}
      title={` ${props.spec.title} `}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={visible()}>
        {(row) => {
          const r = () => props.spec.rows[row.index];
          const on = () => row.index === selected();
          return (
            <box
              flexDirection="row"
              height={1}
              backgroundColor={on() ? PICKER_COLORS.highlight : "transparent"}
            >
              <text flexShrink={0} fg={r()?.current ? PICKER_COLORS.accent : PICKER_COLORS.dim}>
                {r()?.current ? "● " : "  "}
              </text>
              <text
                fg={r()?.dim ? PICKER_COLORS.dim : on() ? PICKER_COLORS.text : PICKER_COLORS.muted}
              >
                {row.text}
              </text>
            </box>
          );
        }}
      </For>
      <text fg={PICKER_COLORS.dim}>{`↑↓ move · Enter picks · Esc closes${more()}`}</text>
    </box>
  );
}
