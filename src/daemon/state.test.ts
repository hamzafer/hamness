import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { claimState, readState } from "./state.ts";

let home: ReturnType<typeof tempHome>;
let path: string;
beforeEach(() => {
  home = tempHome();
  path = join(home.dir, "daemon.json");
});
afterEach(() => home.cleanup());

const STATE_TS = join(import.meta.dir, "state.ts");

/** A process that tries to claim `path`, prints the result, and stays alive a while. */
const claimer = (p: string, at: number) =>
  Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { claimState } = await import(${JSON.stringify(STATE_TS)});
       while (Date.now() < ${at}) {}
       const r = claimState(${JSON.stringify(p)}, process.pid);
       console.log(r.ok ? "won" : "lost");
       await Bun.sleep(500);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

describe("claimState", () => {
  test("the state file is never seen without its pid: it appears whole", () => {
    expect(claimState(path, process.pid)).toEqual({ ok: true });
    expect(readState(path)?.pid).toBe(process.pid);
    expect(readdirSync(home.dir)).toEqual(["daemon.json"]);
  });

  test("a live owner keeps the claim; a dead one's file is replaced", () => {
    expect(claimState(path, process.pid)).toEqual({ ok: true });
    expect(claimState(path, 999_999_999)).toEqual({ ok: false, owner: { pid: process.pid } });
    writeFileSync(path, JSON.stringify({ pid: 999_999_999 }));
    expect(claimState(path, process.pid)).toEqual({ ok: true });
    expect(readdirSync(home.dir)).toEqual(["daemon.json"]);
  });

  test("an empty or torn file from a dead claimer is replaced", () => {
    writeFileSync(path, "");
    expect(claimState(path, process.pid)).toEqual({ ok: true });
    expect(readState(path)?.pid).toBe(process.pid);
  });

  test("of many processes racing for a stale file, exactly one wins", async () => {
    for (let round = 0; round < 3; round++) {
      writeFileSync(path, JSON.stringify({ pid: 999_999_999 }));
      const at = Date.now() + 1000;
      const procs = Array.from({ length: 12 }, () => claimer(path, at));
      const results = await Promise.all(
        procs.map(async (p) => (await new Response(p.stdout).text()).trim()),
      );
      await Promise.all(procs.map((p) => p.exited));
      expect(results.filter((r) => r === "won")).toHaveLength(1);
    }
  }, 30_000);
});
