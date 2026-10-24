import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { checkContext } from "../../../test/support/check-context.ts";
import { tempHome } from "../../../test/support/temp-home.ts";
import type { GuardedCall } from "../../safety/index.ts";
import { checkCommand } from "./command.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

describe("command checker", () => {
  test("passes on exit 0, in the session folder, with duration and output tail", async () => {
    const r = await checkCommand({ kind: "command", command: "pwd; echo ok" }, checkContext(home.dir));
    expect(r.status).toBe("passed");
    expect(r.details.exitCode).toBe(0);
    expect(typeof r.details.durationMs).toBe("number");
    expect(String(r.details.outputTail)).toContain(realpathSync(home.dir));
    expect(String(r.details.outputTail)).toContain("ok");
    expect(r.summary).toContain("exit 0");
  });

  test("fails on a non-zero exit and keeps the tail of stdout and stderr", async () => {
    const r = await checkCommand(
      { kind: "command", command: "echo building; echo 'boom' >&2; exit 3" },
      checkContext(home.dir),
    );
    expect(r.status).toBe("failed");
    expect(r.details.exitCode).toBe(3);
    expect(String(r.details.outputTail)).toContain("building");
    expect(String(r.details.outputTail)).toContain("boom");
  });

  test("keeps only the tail of long output", async () => {
    const r = await checkCommand(
      { kind: "command", command: "for i in $(seq 1 3000); do echo line$i; done" },
      checkContext(home.dir),
    );
    const tail = String(r.details.outputTail);
    expect(tail).toContain("line3000");
    expect(tail).not.toContain("line1\n");
    expect(tail.length).toBeLessThanOrEqual(4000);
  });

  test("fails when the command outlives its timeout, and kills it", async () => {
    const r = await checkCommand(
      { kind: "command", command: "sleep 5; touch late", timeoutSeconds: 0.3 },
      checkContext(home.dir),
    );
    expect(r.status).toBe("failed");
    expect(r.details.timedOut).toBe(true);
    expect(r.summary).toContain("timed out");
    await Bun.sleep(100);
    expect(existsSync(join(home.dir, "late"))).toBe(false);
  });

  test("asks the safety check first, as a bash call, and does not run a denied command", async () => {
    const seen: GuardedCall[] = [];
    const r = await checkCommand(
      { kind: "command", command: "touch ran" },
      checkContext(home.dir, {
        toolCallId: "tc-9",
        safety: async (call) => {
          seen.push(call);
          return { allow: false, reason: "no touching" };
        },
      }),
    );
    expect(seen).toEqual([
      { sessionId: "s-test", toolCallId: "tc-9", tool: "bash", args: { command: "touch ran" } },
    ]);
    expect(r.status).toBe("error");
    expect(r.summary).toContain("no touching");
    expect(existsSync(join(home.dir, "ran"))).toBe(false);
  });

  test("a safety check that throws counts as a deny", async () => {
    const r = await checkCommand(
      { kind: "command", command: "touch ran" },
      checkContext(home.dir, {
        safety: async () => {
          throw new Error("judge down");
        },
      }),
    );
    expect(r.status).toBe("error");
    expect(existsSync(join(home.dir, "ran"))).toBe(false);
  });

  test("redacts secrets in the stored output", async () => {
    const r = await checkCommand(
      { kind: "command", command: "echo API_KEY=abc123def456" },
      checkContext(home.dir),
    );
    expect(String(r.details.outputTail)).not.toContain("abc123def456");
  });

  test("stops when the check is aborted", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const r = await checkCommand(
      { kind: "command", command: "sleep 5" },
      checkContext(home.dir, { signal: ctl.signal }),
    );
    expect(r.status).toBe("error");
    expect(r.summary).toContain("aborted");
  });
});
