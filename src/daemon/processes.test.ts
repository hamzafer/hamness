import { describe, expect, test } from "bun:test";
import {
  envFromPsLine,
  isDaemonArgv,
  isDaemonCommand,
  parseElapsed,
  startMatches,
} from "./processes.ts";
import { terminate } from "./terminate.ts";

describe("isDaemonCommand (ps: the executable, then the command line)", () => {
  test.each([
    ["/opt/bun/bin/bun", "/opt/bun/bin/bun --config=/dev/null /opt/app/src/cli/main.ts daemon"],
    ["bun", "bun /work/hamness/src/cli/main.ts daemon --port 0"],
    ["/opt/bun/bin/bun", "/opt/bun/bin/bun --config=/dev/null /opt/bun/bin/hamness daemon"],
    // Paths with spaces: the default macOS data dir's folder style.
    [
      "/Users/u/My Tools/bun",
      "/Users/u/My Tools/bun /Users/u/Application Support/app/src/cli/main.ts daemon",
    ],
  ])("a daemon: %s %s", (comm, cmd) => expect(isDaemonCommand(comm, cmd)).toBe(true));

  test.each([
    ["/opt/bun/bin/bun", "/opt/bun/bin/bun /opt/app/src/cli/main.ts stop"],
    ["/opt/bun/bin/bun", "/opt/bun/bin/bun /opt/app/src/cli/main.ts daemonize"],
    ["/bin/zsh", "/bin/zsh -c bun /opt/app/src/cli/main.ts daemon"],
    ["grep", "grep main.ts daemon"],
    ["/opt/bun/bin/bun", "/opt/bun/bin/bun test"],
  ])("not a daemon: %s %s", (comm, cmd) => expect(isDaemonCommand(comm, cmd)).toBe(false));
});

describe("isDaemonArgv (Linux /proc cmdline)", () => {
  test("a daemon, paths with spaces too", () => {
    expect(isDaemonArgv(["/opt/bun", "--config=/dev/null", "/a b/src/cli/main.ts", "daemon"])).toBe(
      true,
    );
    expect(isDaemonArgv(["bun", "/home/u/.bun/bin/hamness", "daemon"])).toBe(true);
  });
  test("not a daemon", () => {
    expect(isDaemonArgv(["/bin/sh", "-c", "bun main.ts daemon"])).toBe(false);
    expect(isDaemonArgv(["bun", "/x/main.ts", "stop"])).toBe(false);
    expect(isDaemonArgv([])).toBe(false);
  });
});

describe("startMatches", () => {
  test("a stamp written just after the process started matches", () => {
    expect(startMatches(10_000, 10_400)).toBe(true);
    // ps start times are to the second.
    expect(startMatches(10_000, 9_500)).toBe(true);
  });
  test("a process that started after the stamp is a reused pid", () => {
    expect(startMatches(20_000, 10_000)).toBe(false);
  });
  test("a stamp minutes after the start is not this process's either", () => {
    expect(startMatches(0, 10 * 60_000)).toBe(false);
  });
});

describe("parseElapsed", () => {
  test("reads ps etime", () => {
    expect(parseElapsed("00:07")).toBe(7);
    expect(parseElapsed("12:03")).toBe(723);
    expect(parseElapsed("01:00:00")).toBe(3600);
    expect(parseElapsed("3-02:00:01")).toBe(3 * 86_400 + 7201);
  });
});

describe("envFromPsLine", () => {
  const line =
    "/opt/bun/bin/bun /x/main.ts daemon PATH=/usr/bin HAMNESS_HOME=/Users/u/Library/Application Support/hamness TERM=xterm\n";
  test("reads a value that has spaces, up to the next variable", () => {
    expect(envFromPsLine(line, "HAMNESS_HOME")).toBe(
      "/Users/u/Library/Application Support/hamness",
    );
    expect(envFromPsLine(line, "TERM")).toBe("xterm");
  });
  test("undefined when unset", () => {
    expect(envFromPsLine(line, "HOME")).toBeUndefined();
  });
});

describe("terminate", () => {
  test("a process that exits on SIGTERM", async () => {
    const p = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    expect(await terminate(p.pid, { graceMs: 2000 })).toBe("exited");
    await p.exited;
  });

  test("a process that ignores SIGTERM is killed", async () => {
    const p = Bun.spawn(
      [
        process.execPath,
        "-e",
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")`,
      ],
      { stdout: "pipe" },
    );
    const reader = p.stdout.getReader();
    await reader.read();
    expect(await terminate(p.pid, { graceMs: 300 })).toBe("killed");
    expect(p.signalCode).toBe("SIGKILL");
  });

  test("no SIGKILL for a process that can no longer be confirmed as the one meant", async () => {
    const p = Bun.spawn(
      [
        process.execPath,
        "-e",
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")`,
      ],
      { stdout: "pipe" },
    );
    const reader = p.stdout.getReader();
    await reader.read();
    let checked = 0;
    const outcome = await terminate(p.pid, {
      graceMs: 300,
      stillOurs: () => {
        checked++;
        return false;
      },
    });
    expect(outcome).toBe("unverified");
    expect(checked).toBe(1);
    expect(p.exitCode).toBeNull();
    expect(p.signalCode).toBeNull();
    p.kill("SIGKILL");
    await p.exited;
  });

  test("a pid that is already gone", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    expect(await terminate(p.pid, { graceMs: 100 })).toBe("exited");
  });
});
