import { spawn } from "node:child_process";

/** The clipboard commands to try on this platform, in order. */
export function clipboardCommands(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  const wayland = env.WAYLAND_DISPLAY ? [["wl-copy"]] : [];
  return [...wayland, ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

/** Pipes `text` into `cmd`; resolves true when it exited 0. */
function pipeTo(cmd: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    if (!bin) return resolve(false);
    try {
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copies `text` to the system clipboard: pbcopy on macOS, wl-copy or xclip on Linux, and
 * `osc52` (the terminal's own clipboard escape, which also works over SSH) when none of those
 * is there. Rejects only when every way failed.
 */
export async function copyToClipboard(
  text: string,
  osc52: (text: string) => boolean,
  commands: string[][] = clipboardCommands(),
  pipe: (cmd: string[], text: string) => Promise<boolean> = pipeTo,
): Promise<void> {
  for (const cmd of commands) {
    if (await pipe(cmd, text)) return;
  }
  if (osc52(text)) return;
  throw new Error(
    "couldn't reach a clipboard: install wl-copy or xclip, or use a terminal with OSC 52",
  );
}
