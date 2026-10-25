import { describe, expect, test } from "bun:test";
import { clipboardCommands, copyToClipboard } from "./clipboard.ts";

describe("clipboard", () => {
  test("pbcopy on macOS; wl-copy first under Wayland, then xclip on Linux", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy"]]);
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]).toEqual(["wl-copy"]);
    expect(clipboardCommands("linux", {})[0]).toEqual(["xclip", "-selection", "clipboard"]);
  });

  test("tries each command, then falls back to OSC 52", async () => {
    const tried: string[] = [];
    const osc: string[] = [];
    await copyToClipboard(
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
  });

  test("stops at the first command that works", async () => {
    const tried: string[] = [];
    await copyToClipboard(
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
  });

  test("rejects when nothing worked", async () => {
    await expect(
      copyToClipboard(
        "hi",
        () => false,
        [],
        async () => false,
      ),
    ).rejects.toThrow("clipboard");
  });
});
