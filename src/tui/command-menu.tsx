import { For } from "solid-js";
import { COMMANDS, type CommandMatch } from "./commands.ts";
import { PICKER_COLORS, windowStart } from "./picker.tsx";

/** Rows the `/` menu shows at once. */
export const MENU_ROWS = 8;

/** Column widths over the whole registry, so the menu doesn't jump as the filter narrows. */
const NAME_WIDTH =
  Math.max(...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => n.length))) + 3;
const ARGS_WIDTH = Math.max(...COMMANDS.map((c) => c.args?.length ?? 0)) + 2;

/** One menu row's three columns: `/name`, the argument hint, the description, fit to `width`. */
export function menuRow(
  m: CommandMatch,
  width: number,
): { name: string; args: string; about: string } {
  const name = m.label.padEnd(NAME_WIDTH);
  const args = (m.command.args ?? "").padEnd(ARGS_WIDTH);
  const room = Math.max(0, width - name.length - args.length);
  const d = m.command.description;
  const about = d.length > room ? (room > 1 ? `${d.slice(0, room - 1)}…` : "") : d;
  return { name, args, about };
}

/**
 * The `/` popup above the input box: matching commands with their argument hint and a muted
 * description. The keys live in app.tsx (the input box keeps focus while it shows).
 */
export function CommandMenu(props: { matches: CommandMatch[]; selected: number; width: number }) {
  const visible = () => {
    const from = windowStart(props.selected, props.matches.length, MENU_ROWS);
    return props.matches.slice(from, from + MENU_ROWS).map((m, k) => ({ m, index: from + k }));
  };
  // Inside the border and the padding.
  const inner = () => Math.max(10, props.width - 4);
  return (
    <box
      border
      borderColor={PICKER_COLORS.dim}
      // Where the highlight is in what the filter left. Always set: a title dropped from the
      // props would stay on the box as it was.
      bottomTitle={` ${props.selected + 1} of ${props.matches.length} `}
      bottomTitleAlignment="right"
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={visible()}>
        {(row) => {
          const on = () => row.index === props.selected;
          const cols = () => menuRow(row.m, inner());
          return (
            <box
              flexDirection="row"
              height={1}
              backgroundColor={on() ? PICKER_COLORS.highlight : "transparent"}
            >
              <text flexShrink={0} fg={on() ? PICKER_COLORS.accent : PICKER_COLORS.text}>
                {cols().name}
              </text>
              <text flexShrink={0} fg={PICKER_COLORS.dim}>
                {cols().args}
              </text>
              <text fg={on() ? PICKER_COLORS.text : PICKER_COLORS.muted}>{cols().about}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}
