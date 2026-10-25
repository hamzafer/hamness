import { spawn as nodeSpawn } from "node:child_process";

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

/** How long a clipboard tool gets before it counts as failed. */
export const CLIPBOARD_TIMEOUT_MS = 3000;

/** Terminals cap OSC 52 payloads; past this a reply is refused rather than cut. */
export const OSC52_MAX_BYTES = 100_000;

/**
 * Pipes `text` into `cmd`; resolves true when it exited 0. A missing tool, one that exits
 * without reading (EPIPE on its stdin, e.g. xclip with no display) or one that hangs past
 * the timeout resolves false, so the next way is tried. It never throws.
 */
export function pipeTo(
  cmd: string[],
  text: string,
  opts: { spawn?: typeof nodeSpawn; timeoutMs?: number } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    if (!bin) return resolve(false);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const timer = setTimeout(() => {
      child?.kill();
      finish(false);
    }, opts.timeoutMs ?? CLIPBOARD_TIMEOUT_MS);
    try {
      child = (opts.spawn ?? nodeSpawn)(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stdin?.on("error", () => finish(false));
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
  });
}

/**
 * Copies `text` to the system clipboard: pbcopy on macOS, wl-copy or xclip on Linux. When
 * none of those works it sends `osc52` (the terminal's own clipboard escape, which also works
 * over SSH); the terminal may still ignore it, so that is `terminal`, not a sure copy.
 * Rejects only when every way failed.
 */
export async function copyToClipboard(
  text: string,
  osc52: (text: string) => boolean,
  commands: string[][] = clipboardCommands(),
  pipe: (cmd: string[], text: string) => Promise<boolean> = pipeTo,
): Promise<"system" | "terminal"> {
  for (const cmd of commands) {
    if (await pipe(cmd, text)) return "system";
  }
  if (Buffer.byteLength(text) > OSC52_MAX_BYTES) {
    throw new Error(
      "no clipboard tool worked, and the reply is too long for the terminal's clipboard",
    );
  }
  if (osc52(text)) return "terminal";
  throw new Error(
    "couldn't reach a clipboard: install wl-copy or xclip, or use a terminal with OSC 52",
  );
}
