import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { type RunningDaemon, startDaemon } from "../daemon/daemon.ts";
import { dashboardCommandWith } from "./commands/dashboard.ts";

let home: ReturnType<typeof tempHome>;
let d: RunningDaemon;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

beforeEach(async () => {
  home = tempHome();
  out = [];
  err = [];
  d = await startDaemon({ dataDir: home.dir, port: 0, contextFiles: false });
});
afterEach(async () => {
  await d.stop();
  home.cleanup();
});

const token = () => readFileSync(dataPaths(home.dir).token, "utf8").trim();
const ctx = (args: string[]) => ({ args, env: {}, dataDir: home.dir, io });

describe("hamness dashboard", () => {
  test("--no-open prints the URL with the token in the fragment, not the query", async () => {
    const opened: string[] = [];
    const code = await dashboardCommandWith(async (u) => {
      opened.push(u);
    })(ctx(["--no-open"]));
    expect(code).toBe(0);
    expect(opened).toEqual([]);
    expect(out).toEqual([`${d.url}/dash#token=${token()}`]);
  });

  test("opens the browser and prints the URL without the token", async () => {
    const opened: string[] = [];
    const code = await dashboardCommandWith(async (u) => {
      opened.push(u);
    })(ctx([]));
    expect(code).toBe(0);
    expect(opened).toEqual([`${d.url}/dash#token=${token()}`]);
    expect(out.join("\n")).toContain(`${d.url}/dash`);
    expect(out.join("\n")).not.toContain(token());
  });

  test("when the browser can't open, prints the full URL to use", async () => {
    const code = await dashboardCommandWith(async () => {
      throw new Error("no browser");
    })(ctx([]));
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`${d.url}/dash#token=${token()}`);
    expect(err.join("\n")).toContain("no browser");
  });

  test("the opened page loads", async () => {
    const res = await fetch(`${d.url}/dash`);
    expect(res.status).toBe(200);
  });

  test("unknown flags are a usage error", async () => {
    expect(await dashboardCommandWith(async () => {})(ctx(["--nope"]))).toBe(2);
  });
});
