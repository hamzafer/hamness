import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

  test("starts the daemon from a folder whose bunfig.toml preloads something missing", async () => {
    // The child inherits the cwd, and Bun applies that folder's bunfig.toml to it.
    const dataDir = join(home.dir, "data");
    const project = join(home.dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./missing.ts"]\n');
    const before = process.cwd();
    process.chdir(project);
    try {
      await ensureDaemon(dataDir, { env: { ...process.env, HAMNESS_PORT: "0" } });
    } finally {
      process.chdir(before);
    }
    const status = await getStatus(dataDir);
    if (!status.running) throw new Error("daemon not running");
    cleanups.push(async () => {
      process.kill(status.pid, "SIGTERM");
      for (let i = 0; i < 100 && (await getStatus(dataDir)).running; i++) await Bun.sleep(20);
    });
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

  test("the slash-command calls reach the daemon", async () => {
    const work = join(home.dir, "work");
    mkdirSync(work);
    const client = await connectToDaemon(join(home.dir, "data"));
    const events: HamnessEvent[] = [];
    cleanups.push(client.subscribe((e) => events.push(e)));
    await client.ready;
    const snap = await client.attach(work);
    const id = snap.session.id;
    expect(await client.lastReply(id)).toBeUndefined();
    await client.prompt(id, "hi");
    for (let i = 0; i < 200; i++) {
      if (events.some((e) => e.type === "agent.status" && !e.busy)) break;
      await Bun.sleep(10);
    }
    expect(await client.lastReply(id)).toBe("hello there");
    expect((await client.rename(id, "demo")).session.name).toBe("demo");
    expect((await client.status(id)).name).toBe("demo");
    expect((await client.listSessions(work)).map((s) => s.name)).toEqual(["demo"]);
    expect((await client.thinking(id)).level).toBeDefined();
    expect(await client.compat(id)).toEqual({ skills: [], mcpServers: [] });
    const path = await client.exportSession(id, "jsonl");
    expect(path.endsWith(".jsonl")).toBe(true);
    await expect(client.compact(id)).rejects.toThrow(/nothing to compact/i);
    const next = await client.newSession(id);
    expect(next.session.id).not.toBe(id);
    expect((await client.resume(next.session.id, id)).session.id).toBe(id);
  });

  test("a failed request rejects with the daemon's error", async () => {
    const client = await connectToDaemon(join(home.dir, "data"));
    await expect(client.attach("relative")).rejects.toThrow(/absolute/);
  });
});
