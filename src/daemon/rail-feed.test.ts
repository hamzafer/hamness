import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

/** What the side rail needs from the daemon: agent ids, context fill and stored totals. */

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let daemon: RunningDaemon | undefined;
let log: Awaited<ReturnType<typeof eventLog>> | undefined;

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir);
});
afterEach(async () => {
  log?.close();
  log = undefined;
  await daemon?.stop();
  daemon = undefined;
  home.cleanup();
});

async function start() {
  daemon = await startDaemon({
    dataDir: join(home.dir, "data"),
    port: 0,
    models: async () => fake,
    contextFiles: false,
  });
  const token = readFileSync(dataPaths(join(home.dir, "data")).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { d: daemon, log, call };
}

const settled = (sessionId: string) => (e: HamnessEvent) =>
  e.type === "agent.status" && e.sessionId === sessionId && !e.busy;

describe("the side rail's feed from the daemon", () => {
  test("every session event names the main agent, and each model call reports context fill", async () => {
    writeFileSync(join(work, "notes.txt"), "fig\n");
    fake.script([
      {
        tools: [{ name: "read", args: { path: "notes.txt" } }],
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 },
      },
      { text: "fig", usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const main = s.session.mainAgentId;
    expect(main).toMatch(/^[0-9a-f-]{36}$/);
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "word?" });
    await log.waitFor(settled(s.session.id));

    const sessionEvents = log.events.filter((e) => "sessionId" in e);
    expect(sessionEvents.length).toBeGreaterThan(5);
    for (const e of sessionEvents) expect("agentId" in e && e.agentId).toBe(main as string);

    const context = log.ofType("agent.context");
    expect(context).toHaveLength(2);
    // The fake model's window is 128k; the last call used 1000 + 10 tokens.
    expect(context[1]).toMatchObject({ tokens: 1010, contextWindow: 128_000 });
    expect(context[1]?.percent).toBeCloseTo((1010 / 128_000) * 100, 3);
  });

  test("the snapshot carries each agent's stored tokens and cost, and the last context fill", async () => {
    fake.script([
      { text: "one", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 } },
      { text: "two", usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const { call, log } = await start();
    const first = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(first.agents).toEqual([
      { id: first.session.mainAgentId as string, kind: "main", tokens: 0, costMicros: 0 },
    ]);
    const id = first.session.id;
    await call("POST", `/v1/sessions/${id}/prompt`, { text: "a" });
    await log.waitFor(settled(id));
    log.events.length = 0;
    await call("POST", `/v1/sessions/${id}/prompt`, { text: "b" });
    await log.waitFor(settled(id));

    const back = (await (await call("GET", `/v1/sessions/${id}`)).json()) as SessionSnapshot;
    // 836 + 400 micro-dollars (Opus 5.5 prices); tokens are all four kinds added up.
    expect(back.agents).toEqual([
      { id: first.session.mainAgentId as string, kind: "main", tokens: 192, costMicros: 1236 },
    ]);
    expect(back.context).toMatchObject({ tokens: 60, contextWindow: 128_000 });
  });
});
