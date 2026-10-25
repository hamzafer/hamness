import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import type { ModelChoice, ModelInfo } from "../agent/models.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let daemon: RunningDaemon | undefined;
let log: Awaited<ReturnType<typeof eventLog>> | undefined;

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir, "claude-opus-5-5", { otherModels: ["claude-haiku-5-5"] });
});
afterEach(async () => {
  log?.close();
  log = undefined;
  await daemon?.stop();
  daemon = undefined;
  home.cleanup();
});

const dataDir = () => join(home.dir, "data");

async function start(models: ModelChoice = fake) {
  log?.close();
  daemon = await startDaemon({
    dataDir: dataDir(),
    port: 0,
    models: async () => models,
    contextFiles: false,
  });
  const token = readFileSync(dataPaths(dataDir()).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const d = daemon;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${d.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { d, log, call };
}

const settled = (sessionId: string) => (e: HamnessEvent) =>
  e.type === "agent.status" && e.sessionId === sessionId && !e.busy;

describe("models over the API", () => {
  test("GET /v1/models lists the models that have credentials", async () => {
    const { call } = await start();
    const res = await call("GET", "/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: ModelInfo[] };
    // Providers keyed in the real environment may show up too; only the fake ones are pinned here.
    expect(body.models.map((m) => m.id).filter((m) => m.startsWith("fake/"))).toEqual([
      "fake/claude-haiku-5-5",
      "fake/claude-opus-5-5",
    ]);
    expect(body.models.find((m) => m.id === "fake/claude-opus-5-5")).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
      priced: true,
    });
  });

  test("switching models mid-session: the next call uses the new model and each call records its own", async () => {
    fake.script([
      { text: "one", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } },
      { text: "two", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const { d, call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const id = s.session.id;
    await call("POST", `/v1/sessions/${id}/prompt`, { text: "first" });
    await log.waitFor(settled(id));

    const res = await call("POST", `/v1/sessions/${id}/model`, { model: "fake/claude-haiku-5-5" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionSnapshot).session.model).toBe("fake/claude-haiku-5-5");
    await log.waitFor((e) => e.type === "agent.model" && e.model === "fake/claude-haiku-5-5");

    await call("POST", `/v1/sessions/${id}/prompt`, { text: "second" });
    await log.waitFor((e) => e.type === "agent.usage" && e.model === "claude-haiku-5-5");
    await log.waitFor(settled(id));

    const q = <T>(sql: string) => d.db.sqlite.query<T, [string]>(sql).all(id);
    // Opus 5.5: 1000*4 + 100*20 = 6000; Haiku 5.5: 1000*0.1 + 100*0.5 = 150 (micro-dollars)
    expect(
      q("SELECT model, cost_micros FROM model_calls WHERE session_id = ? ORDER BY id"),
    ).toEqual([
      { model: "claude-opus-5-5", cost_micros: 6000 },
      { model: "claude-haiku-5-5", cost_micros: 150 },
    ]);
    expect(q("SELECT model FROM sessions WHERE id = ?")).toEqual([
      { model: "fake/claude-haiku-5-5" },
    ]);
    expect(q("SELECT model FROM agents WHERE session_id = ?")).toEqual([
      { model: "fake/claude-haiku-5-5" },
    ]);
    // The new model saw the whole conversation so far.
    expect(JSON.stringify(fake.contexts[1]?.messages)).toContain("first");
  });

  test("an unknown model is a 400 that names it; the session keeps its model", async () => {
    const { call } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const res = await call("POST", `/v1/sessions/${s.session.id}/model`, { model: "fake/nope-9" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("fake/nope-9");
    const again = (await (
      await call("GET", `/v1/sessions/${s.session.id}`)
    ).json()) as SessionSnapshot;
    expect(again.session.model).toBe("fake/claude-opus-5-5");
    expect((await call("POST", `/v1/sessions/${s.session.id}/model`, {})).status).toBe(400);
    expect(
      (await call("POST", "/v1/sessions/nope/model", { model: "fake/claude-haiku-5-5" })).status,
    ).toBe(404);
  });

  test("a cost with 1-hour cache writes is priced at 2x input", async () => {
    fake.script([
      {
        text: "ok",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 },
      },
    ]);
    const { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "hi" });
    const usage = (await log.waitFor((e) => e.type === "agent.usage")) as Extract<
      HamnessEvent,
      { type: "agent.usage" }
    >;
    // Opus 5.5 1-hour write: $8/MTok, 1000 tokens = 8000 micro-dollars
    expect(usage.costMicros).toBe(8000);
  });
});

describe("resume after a daemon restart", () => {
  test("attaching to the cwd again picks up the last session, its transcript and its context", async () => {
    fake.script([{ text: "The word is fig." }, { text: "You asked about the word." }]);
    let { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/model`, { model: "fake/claude-haiku-5-5" });
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "what is the word?" });
    await log.waitFor(settled(s.session.id));
    await daemon?.stop();

    ({ call, log } = await start());
    const back = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(back.session.id).toBe(s.session.id);
    expect(back.session.model).toBe("fake/claude-haiku-5-5");
    expect(back.items.map((i) => (i.kind === "message" ? `${i.role}: ${i.text}` : i.kind))).toEqual(
      ["user: what is the word?", "assistant: The word is fig."],
    );

    await call("POST", `/v1/sessions/${back.session.id}/prompt`, { text: "what did I ask?" });
    await log.waitFor(settled(back.session.id));
    const context = JSON.stringify(fake.contexts.at(-1)?.messages);
    expect(context).toContain("what is the word?");
    expect(context).toContain("The word is fig.");
  });

  test("a session with nothing said yet is not resumed", async () => {
    let { call } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await daemon?.stop();
    ({ call } = await start());
    const back = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(back.session.id).not.toBe(s.session.id);
  });
});

describe("billing (ADR 0024)", () => {
  const plan = (): ModelChoice => ({ ...fake, billing: () => ({ kind: "plan" }) });

  test("a ChatGPT plan call keeps its tokens, costs $0 and is marked plan", async () => {
    fake.script([{ text: "ok", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } }]);
    const { d, call, log } = await start(plan());
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    expect(s.session.billing).toBe("plan");
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "hi" });
    const usage = (await log.waitFor((e) => e.type === "agent.usage")) as Extract<
      HamnessEvent,
      { type: "agent.usage" }
    >;
    expect(usage).toMatchObject({ costMicros: 0, inputTokens: 1000, billing: "plan" });
    await log.waitFor(settled(s.session.id));
    expect(
      d.db.sqlite
        .query("SELECT input_tokens, cost_micros, billing FROM model_calls WHERE session_id = ?")
        .all(s.session.id),
    ).toEqual([{ input_tokens: 1000, cost_micros: 0, billing: "plan" }]);
    const status = (await (await call("GET", `/v1/sessions/${s.session.id}/status`)).json()) as {
      billing?: string;
      planCalls?: number;
      costMicros: number;
    };
    expect(status).toMatchObject({ billing: "plan", planCalls: 1, costMicros: 0 });
  });

  test("a stored model with no key switches to the default, and says so", async () => {
    fake.script([{ text: "one" }, { text: "two" }]);
    let { d, call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "first" });
    await log.waitFor(settled(s.session.id));
    // As if the session was last used with a provider that has no key now.
    d.db.sqlite
      .query("UPDATE sessions SET model = 'cerebras/gpt-oss-120b' WHERE id = ?")
      .run(s.session.id);
    await daemon?.stop();

    const billing = (p: string) => (p === "fake" ? { kind: "plan" as const } : undefined);
    ({ d, call, log } = await start({ ...fake, billing }));
    const back = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(back.session.id).toBe(s.session.id);
    expect(back.session.model).toBe("fake/claude-opus-5-5");
    await call("POST", `/v1/sessions/${back.session.id}/prompt`, { text: "second" });
    const notice = await log.waitFor((e) => e.type === "agent.notice");
    expect(notice).toMatchObject({
      message: "Switched to fake/claude-opus-5-5 (plan): cerebras/gpt-oss-120b has no key.",
    });
    await log.waitFor(settled(back.session.id));
    expect(
      d.db.sqlite.query("SELECT model FROM sessions WHERE id = ?").get(back.session.id),
    ).toEqual({ model: "fake/claude-opus-5-5" });
  });

  test("/new keeps the session's live model, even one the default would replace", async () => {
    fake.script([{ text: "one" }]);
    const billing = (p: string) => (p === "fake" ? { kind: "plan" as const } : undefined);
    const { call, log } = await start({ ...fake, billing });
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/model`, { model: "fake/claude-haiku-5-5" });
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "first" });
    await log.waitFor(settled(s.session.id));
    const res = await call("POST", `/v1/sessions/${s.session.id}/new`, {});
    const next = (await res.json()) as SessionSnapshot;
    expect(next.session.model).toBe("fake/claude-haiku-5-5");
  });

  test("an empty reply with no error says so; on the plan the model is set aside", async () => {
    fake.script([{ text: "" }]);
    const { call, log } = await start(plan());
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "hi" });
    const end = await log.waitFor((e) => e.type === "agent.message.end" && e.role === "assistant");
    expect(end).toMatchObject({
      error: expect.stringContaining("ended without a reply or an error"),
    });
    // No other plan model to move to (the fake provider is no ChatGPT plan): it says so, once.
    const notice = await log.waitFor((e) => e.type === "agent.notice");
    expect(notice).toMatchObject({ message: expect.stringContaining("no other plan model") });
    const models = (await (await call("GET", "/v1/models")).json()) as { models: ModelInfo[] };
    expect(models.models.map((m) => m.id)).not.toContain("fake/claude-opus-5-5");
  });
});
