import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { clipboardCommands, copyToClipboard, OSC52_MAX_BYTES, pipeTo } from "./clipboard.ts";

/** A child process stand-in: no real clipboard tool ever runs in these tests. */
function fakeChild(opts: { exit?: number; stdinError?: boolean; hang?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: (t: string) => void };
    kill: () => void;
    killed: boolean;
  };
  const stdin = new EventEmitter() as EventEmitter & { end: (t: string) => void };
  stdin.end = () => {
    queueMicrotask(() => {
      if (opts.stdinError) {
        stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        child.emit("close", 1);
      } else if (!opts.hang) child.emit("close", opts.exit ?? 0);
    });
  };
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

describe("clipboard", () => {
  test("pbcopy on macOS; wl-copy first under Wayland, then xclip on Linux", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy"]]);
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]).toEqual(["wl-copy"]);
    expect(clipboardCommands("linux", {})[0]).toEqual(["xclip", "-selection", "clipboard"]);
  });

  test("tries each command, then falls back to OSC 52, and says it only sent it", async () => {
    const tried: string[] = [];
    const osc: string[] = [];
    const how = await copyToClipboard(
      "hi",
      (t) => {
        osc.push(t);
        return true;
      },
      [["a"], ["b"]],
      async (cmd) => {
        tried.push(cmd[0] ?? "");
        return false;
      },
    );
    expect(tried).toEqual(["a", "b"]);
    expect(osc).toEqual(["hi"]);
    expect(how).toBe("terminal");
  });

  test("stops at the first command that works", async () => {
    const tried: string[] = [];
    const how = await copyToClipboard(
      "hi",
      () => {
        throw new Error("not reached");
      },
      [["a"], ["b"]],
      async (cmd) => {
        tried.push(cmd[0] ?? "");
        return true;
      },
    );
    expect(tried).toEqual(["a"]);
    expect(how).toBe("system");
  });

  test("rejects when nothing worked, and OSC 52 is never sent a huge reply", async () => {
    await expect(
      copyToClipboard(
        "hi",
        () => false,
        [],
        async () => false,
      ),
    ).rejects.toThrow("clipboard");
    let sent = 0;
    const huge = "x".repeat(OSC52_MAX_BYTES + 1);
    await expect(
      copyToClipboard(
        huge,
        () => {
          sent++;
          return true;
        },
        [],
        async () => false,
      ),
    ).rejects.toThrow(/too long/);
    expect(sent).toBe(0);
  });

  test("a tool that exits without reading (EPIPE) is a failure, not a crash", async () => {
    const ok = await pipeTo(["xclip"], "hi", {
      spawn: () => fakeChild({ stdinError: true }) as never,
    });
    expect(ok).toBe(false);
  });

  test("a tool that hangs is given up on after the timeout", async () => {
    const child = fakeChild({ hang: true });
    const ok = await pipeTo(["wl-copy"], "hi", { spawn: () => child as never, timeoutMs: 20 });
    expect(ok).toBe(false);
    expect(child.killed).toBe(true);
  });

  test("a tool that exits 0 worked", async () => {
    expect(await pipeTo(["pbcopy"], "hi", { spawn: () => fakeChild() as never })).toBe(true);
    expect(await pipeTo(["pbcopy"], "hi", { spawn: () => fakeChild({ exit: 1 }) as never })).toBe(
      false,
    );
  });
});
