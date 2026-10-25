import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";

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
  /** A heading shown above the first row of each run of rows with the same group. */
  group?: string;
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
 * Whether a row matches the filter: every word of `query` is in its cells or group, any case.
 * An empty query matches every row.
 */
export function rowMatches(row: PickerRow, query: string): boolean {
  const hay = [row.group ?? "", ...row.cells].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** A key that types a character into the filter (not a control or a named key). */
function typedChar(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.option) return undefined;
  const s = key.sequence;
  if (s?.length !== 1 || s < " " || s === "\x7f") return undefined;
  return s;
}

/**
 * A list to pick one row from (`/resume`, `/fork`, `/thinking`, `/mode`, `/model`). Typing
 * filters it, Backspace undoes a letter, Up/Down move, Enter picks, Esc clears the filter, then
 * closes. It owns the keyboard while it shows.
 */
export function Picker(props: { spec: PickerSpec; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  /** Indexes into `spec.rows` that pass the filter. */
  const shown = createMemo(() =>
    props.spec.rows.flatMap((r, i) => (rowMatches(r, query()) ? [i] : [])),
  );
  const total = () => shown().length;
  /** The highlighted row, as an index into `spec.rows`. */
  const [selectedRow, setSelectedRow] = createSignal(
    Math.min(Math.max(0, props.spec.start ?? 0), Math.max(0, props.spec.rows.length - 1)),
  );
  /** Its position among the shown rows: the first one when the filter hid it. */
  const selected = () => Math.max(0, shown().indexOf(selectedRow()));
  const move = (by: number) => {
    const n = total();
    if (!n) return;
    setSelectedRow(shown()[(selected() + by + n) % n] ?? 0);
  };
  useKeyboard((key) => {
    if (key.name === "escape") {
      if (query()) setQuery("");
      else props.onClose();
    } else if (key.name === "up" || (key.ctrl && key.name === "p")) move(-1);
    else if (key.name === "down" || (key.ctrl && key.name === "n")) move(1);
    else if (key.name === "return" || key.name === "kpenter") {
      const i = shown()[selected()];
      if (i === undefined) return;
      // Read before closing: the spec is gone once the picker unmounts.
      const { onPick } = props.spec;
      props.onClose();
      onPick(i);
    } else if (key.name === "backspace") setQuery((q) => q.slice(0, -1));
    else {
      const ch = typedChar(key);
      if (ch !== undefined) setQuery((q) => q + ch);
    }
  });
  const lines = () => alignRows(props.spec.rows);
  const visible = () => {
    const from = windowStart(selected(), total(), PICKER_ROWS);
    return shown()
      .slice(from, from + PICKER_ROWS)
      .map((index, k, all) => {
        const group = props.spec.rows[index]?.group;
        const prev = k > 0 ? props.spec.rows[all[k - 1] ?? -1]?.group : undefined;
        return { text: lines()[index] ?? "", index, heading: group && group !== prev ? group : "" };
      });
  };
  const more = () => (total() > PICKER_ROWS ? `  ${selected() + 1}/${total()}` : "");
  const title = () => ` ${props.spec.title}${query() ? ` · ${query()}` : ""} `;
  return (
    <box
      border
      borderColor={PICKER_COLORS.dim}
      title={title()}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={visible()}>
        {(row) => {
          const r = () => props.spec.rows[row.index];
          const on = () => row.index === shown()[selected()];
          return (
            <>
              <Show when={row.heading}>
                <text fg={PICKER_COLORS.dim}>{row.heading}</text>
              </Show>
              <box
                flexDirection="row"
                height={1}
                backgroundColor={on() ? PICKER_COLORS.highlight : "transparent"}
              >
                <text flexShrink={0} fg={r()?.current ? PICKER_COLORS.accent : PICKER_COLORS.dim}>
                  {r()?.current ? "● " : "  "}
                </text>
                <text
                  fg={
                    r()?.dim ? PICKER_COLORS.dim : on() ? PICKER_COLORS.text : PICKER_COLORS.muted
                  }
                >
                  {row.text}
                </text>
              </box>
            </>
          );
        }}
      </For>
      <Show when={total() === 0}>
        <text fg={PICKER_COLORS.muted}>{`  Nothing matches "${query()}".`}</text>
      </Show>
      <text fg={PICKER_COLORS.dim}>
        {`Type to filter · ↑↓ move · Enter picks · Esc ${query() ? "clears" : "closes"}${more()}`}
      </text>
    </box>
  );
}
