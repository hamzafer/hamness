import { COMMANDS } from "./commands.ts";

/** `/help`'s command rows, generated from the registry: usage, then what it does. */
export const SLASH_COMMANDS: ReadonlyArray<readonly [string, string]> = COMMANDS.map((c) => {
  const usage = `/${c.name}${c.args ? ` ${c.args}` : ""}`;
  const also = c.aliases?.length ? `  (also ${c.aliases.map((a) => `/${a}`).join(", ")})` : "";
  return [`${usage}${also}`, c.description] as const;
});

export const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Enter", "Send the prompt"],
  ["Shift+Enter, Ctrl+J", "New line in the prompt"],
  ["/", "Command menu: Tab completes, Enter runs"],
  ["Esc", "Stop the reply; close a menu or panel"],
  ["y / a / n", "Allow once, allow always, deny"],
  ["Ctrl+R", "Rail full screen, and back"],
  ["Ctrl+C", "Leave (the session keeps running)"],
];

const MUTED = "#737aa2";
const TEXT = "#c0caf5";
const DIM = "#565f89";

export function HelpPanel() {
  const width = Math.max(...[...SLASH_COMMANDS, ...KEYS].map(([c]) => c.length)) + 3;
  const row = ([cmd, what]: readonly [string, string]) => (
    <box flexDirection="row" height={1}>
      <text flexShrink={0} fg={TEXT}>{`  ${cmd.padEnd(width)}`}</text>
      <text fg={MUTED}>{what}</text>
    </box>
  );
  return (
    <box
      border
      borderColor={DIM}
      flexDirection="column"
      flexShrink={0}
      title=" Help "
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={MUTED}>Commands</text>
      {SLASH_COMMANDS.map(row)}
      <text fg={MUTED}>Keys</text>
      {KEYS.map(row)}
      <text fg={DIM}>Esc closes</text>
    </box>
  );
}
