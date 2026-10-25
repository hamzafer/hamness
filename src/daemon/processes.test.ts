import { describe, expect, test } from "bun:test";
import { envFromPsLine, isDaemonCommand, parseElapsed } from "./processes.ts";
import { terminate } from "./terminate.ts";

describe("isDaemonCommand", () => {
  test.each([
    "/opt/bun/bin/bun --config=/dev/null /opt/app/src/cli/main.ts daemon",
    "bun /work/hamness/src/cli/main.ts daemon --port 0",
    "/opt/bun/bin/bun --config=/dev/null /opt/bun/bin/hamness daemon",
  ])("a daemon: %s", (cmd) => expect(isDaemonCommand(cmd)).toBe(true));

  test.each([
    "/opt/bun/bin/bun /opt/app/src/cli/main.ts stop",
    "/opt/bun/bin/bun /opt/app/src/cli/main.ts daemonize",
    "/bin/zsh -c bun /opt/app/src/cli/main.ts daemon",
    "grep main.ts daemon",
    "/opt/bun/bin/bun test",
  ])("not a daemon: %s", (cmd) => expect(isDaemonCommand(cmd)).toBe(false));
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

  test("a pid that is already gone", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    expect(await terminate(p.pid, { graceMs: 100 })).toBe("exited");
  });
});
