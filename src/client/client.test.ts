import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type RunningDaemon, startDaemon } from "../daemon/daemon.ts";
import { getStatus } from "../daemon/status.ts";
import type { HamnessEvent } from "../events/types.ts";
import { connectToDaemon, ensureDaemon } from "./client.ts";

let home: ReturnType<typeof tempHome>;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  home.cleanup();
});

describe("ensureDaemon", () => {
  test("starts a detached daemon when none runs, then reuses it", async () => {
    const dataDir = join(home.dir, "data");
    const first = await ensureDaemon(dataDir, { env: { ...process.env, HAMNESS_PORT: "0" } });
    const status = await getStatus(dataDir);
    if (!status.running) throw new Error("daemon not running");
    cleanups.push(async () => {
      process.kill(status.pid, "SIGTERM");
      for (let i = 0; i < 100 && (await getStatus(dataDir)).running; i++) await Bun.sleep(20);
    });
    expect(first.started).toBe(true);
    expect(first.url).toBe(status.url);
    expect(status.pid).not.toBe(process.pid);

    const second = await ensureDaemon(dataDir, { env: { ...process.env, HAMNESS_PORT: "0" } });
    expect(second.started).toBe(false);
    expect(second.url).toBe(first.url);
  }, 15_000);

  test("a daemon that can't start says why in one line", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    cleanups.push(() => blocker.stop(true));
    const dataDir = join(home.dir, "data");
    const env = { ...process.env, HAMNESS_PORT: String(blocker.port) };
    await expect(ensureDaemon(dataDir, { env })).rejects.toThrow(
      `the hamness daemon did not start: port ${blocker.port} is in use; stop what holds it, or pick another with HAMNESS_PORT=<n> (0 picks a free one)`,
    );
  }, 15_000);
});

describe("daemon client", () => {
  let daemon: RunningDaemon;
  beforeEach(async () => {
    const fake = await fakeModel(home.dir);
    fake.script([{ text: "hello there" }]);
    daemon = await startDaemon({
      dataDir: join(home.dir, "data"),
      port: 0,
      models: async () => fake,
      contextFiles: false,
    });
    cleanups.push(() => daemon.stop());
  });

  test("attaches, prompts and receives the streamed reply", async () => {
    const work = join(home.dir, "work");
    mkdirSync(work);
    const client = await connectToDaemon(join(home.dir, "data"));
    const events: HamnessEvent[] = [];
    const off = client.subscribe((e) => events.push(e));
    cleanups.push(off);
    await client.ready;

    const snap = await client.attach(work);
    expect(snap.session.cwd).toBe(work);
    await client.prompt(snap.session.id, "hi");
    for (let i = 0; i < 200; i++) {
      if (events.some((e) => e.type === "agent.status" && !e.busy)) break;
      await Bun.sleep(10);
    }
    const replies = events.filter(
      (e) => e.type === "agent.message.end" && e.role === "assistant",
    ) as Array<{ text: string }>;
    expect(replies.map((r) => r.text)).toEqual(["hello there"]);
  });

  test("a failed request rejects with the daemon's error", async () => {
    const client = await connectToDaemon(join(home.dir, "data"));
    await expect(client.attach("relative")).rejects.toThrow(/absolute/);
  });
});
