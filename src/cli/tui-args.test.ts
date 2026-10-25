import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempHome } from "../../test/support/temp-home.ts";
import { parseTuiArgs, TUI_USAGE } from "./commands/tui.ts";
import type { CliIo } from "./io.ts";
import { runCli, USAGE } from "./run.ts";

describe("hamness's launch flags (ADR 0023)", () => {
  test("no flag: a fresh chat", () => {
    expect(parseTuiArgs([])).toEqual({ launch: { kind: "new" }, openResume: false });
  });

  test("-c / --continue: the folder's latest session", () => {
    for (const flag of ["-c", "--continue"]) {
      expect(parseTuiArgs([flag])).toEqual({ launch: { kind: "continue" }, openResume: false });
    }
  });

  test("-r / --resume <id>: that session; with no id, the picker over a fresh chat", () => {
    for (const args of [["-r", "abc"], ["--resume", "abc"], ["--resume=abc"]]) {
      expect(parseTuiArgs(args)).toEqual({
        launch: { kind: "session", id: "abc" },
        openResume: false,
      });
    }
    for (const flag of ["-r", "--resume"]) {
      expect(parseTuiArgs([flag])).toEqual({ launch: { kind: "new" }, openResume: true });
    }
  });

  test("anything else is an error", () => {
    expect(parseTuiArgs(["-c", "-r"])).toEqual({ error: "use -c or -r, not both" });
    expect(parseTuiArgs(["--bogus"])).toEqual({ error: "unknown option '--bogus'" });
    expect(parseTuiArgs(["-r", "a", "b"])).toEqual({ error: "unexpected argument 'b'" });
    expect(parseTuiArgs(["--resume="])).toEqual({ error: "--resume= needs a session id" });
  });

  test("the help documents both", () => {
    for (const text of [USAGE, TUI_USAGE]) {
      expect(text).toContain("-c, --continue");
      expect(text).toContain("-r, --resume [id]");
    }
  });
});

describe("the flags reach the TUI command", () => {
  let home: ReturnType<typeof tempHome>;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => home.cleanup());

  const io = () => {
    const err: string[] = [];
    const out: string[] = [];
    const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
    return { cli, err, out };
  };

  test("`hamness -c` is the TUI's flag, not an unknown command", async () => {
    const t = io();
    await runCli(["-c"], { HAMNESS_HOME: home.dir }, t.cli);
    expect(t.err.join("\n")).not.toContain("unknown command");
  });

  test("a bad flag exits 2 with the TUI's usage", async () => {
    for (const argv of [["--bogus"], ["tui", "--bogus"]]) {
      const t = io();
      expect(await runCli(argv, { HAMNESS_HOME: home.dir }, t.cli)).toBe(2);
      expect(t.err[0]).toBe("hamness: unknown option '--bogus'");
      expect(t.err.join("\n")).toContain("Usage: hamness tui");
    }
  });
});
