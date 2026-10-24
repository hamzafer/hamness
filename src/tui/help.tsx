/** The TUI's slash commands, as `/help` lists them. Keep in step with `submit` in app.tsx. */
export const SLASH_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["/task <goal>", "open a task (verified by its evidence)"],
  ["/override [reason]", "accept the task without proof"],
  ["/abandon [reason]", "drop the open task"],
  ["/model [provider/id]", "switch model (alone: the picker)"],
  ["/judge resume", "turn a paused judge back on"],
  ["/help", "this list"],
];

export const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Enter", "send the prompt"],
  ["Shift+Enter, Ctrl+J", "new line in the prompt"],
  ["Esc", "stop the prompt; close this list"],
  ["y / a / n", "allow once, allow always, deny"],
  ["Ctrl+R", "rail full screen, and back"],
  ["Ctrl+C", "leave (the session keeps running)"],
];

/** The names `/help` lists, for telling a typo from a prompt. */
export const COMMAND_WORDS = new Set(SLASH_COMMANDS.map(([c]) => c.split(" ")[0] as string));

const MUTED = "#737aa2";
const TEXT = "#c0caf5";

export function HelpPanel() {
  const width = Math.max(...[...SLASH_COMMANDS, ...KEYS].map(([c]) => c.length)) + 2;
  const row = ([cmd, what]: readonly [string, string]) => (
    <text fg={TEXT}>{`  ${cmd.padEnd(width)}${what}`}</text>
  );
  return (
    <box border flexDirection="column" flexShrink={0} title="help (Esc closes)">
      <text fg={MUTED}>Commands</text>
      {SLASH_COMMANDS.map(row)}
      <text fg={MUTED}>Keys</text>
      {KEYS.map(row)}
    </box>
  );
}
