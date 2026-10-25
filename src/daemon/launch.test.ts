import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { NotSetUpError } from "../agent/models.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

/** How a launch picks its session (ADR 0023): fresh by default, `-c` and `-r` to go back. */

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
const DEFAULT = "fake/claude-opus-5-5";
const OTHER = "fake/claude-haiku-5-5";

async function start() {
  log?.close();
  daemon = await startDaemon({
    dataDir: dataDir(),
    port: 0,
    models: async () => fake,
    contextFiles: false,
    safety: async () => ({ allow: true as const }),
  });
  const token = readFileSync(dataPaths(dataDir()).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const d = daemon;
  const l = log;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${d.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const launch = async (how: Record<string, unknown>, cwd = work) => {
    const res = await call("POST", "/v1/sessions", { cwd, ...how });
    return { status: res.status, body: (await res.json()) as SessionSnapshot & { error?: string } };
  };
  const fresh = async () => (await launch({ start: "new" })).body;
  const settled = (id: string) => (e: HamnessEvent) =>
    e.type === "agent.status" && "sessionId" in e && e.sessionId === id && !e.busy;
  const say = async (id: string, text: string) => {
    const res = await call("POST", `/v1/sessions/${id}/prompt`, { text });
    expect(res.status).toBe(202);
    await l.waitFor(settled(id));
  };
  return { d, call, launch, fresh, say };
}

const texts = (s: SessionSnapshot) =>
  s.items.map((i) => (i.kind === "message" ? `${i.role}: ${i.text}` : i.kind));

describe("a plain launch opens a fresh chat", () => {
  test("a new session even when the folder has an old one, live or from before a restart", async () => {
    fake.script([{ text: "a" }]);
    let { fresh, say } = await start();
    const old = await fresh();
    await say(old.session.id, "hi");

    const second = await fresh();
    expect(second.session.id).not.toBe(old.session.id);
    expect(second.items).toEqual([]);

    await daemon?.stop();
    ({ fresh } = await start());
    const third = await fresh();
    expect(third.session.id).not.toBe(old.session.id);
    expect(third.items).toEqual([]);
  });

  test("it uses the default model, not the model the last session switched to", async () => {
    fake.script([{ text: "a" }]);
    let { call, fresh, say } = await start();
    const old = await fresh();
    await call("POST", `/v1/sessions/${old.session.id}/model`, { model: OTHER });
    await say(old.session.id, "hi");
    expect((await fresh()).session.model).toBe(DEFAULT);

    await daemon?.stop();
    ({ fresh } = await start());
    expect((await fresh()).session.model).toBe(DEFAULT);
  });

  test("a second window gets its own session; the first one keeps working in its own", async () => {
    fake.script([{ text: "a" }, { text: "b" }]);
    const { call, fresh, say } = await start();
    const one = await fresh();
    await say(one.session.id, "first window");
    const two = await fresh();
    expect(two.session.id).not.toBe(one.session.id);
    // The first window's idle session was put to sleep by the launch; its next prompt wakes it.
    await say(one.session.id, "still here");
    const back = (await (
      await call("GET", `/v1/sessions/${one.session.id}`)
    ).json()) as SessionSnapshot;
    expect(texts(back)).toEqual([
      "user: first window",
      "assistant: a",
      "user: still here",
      "assistant: b",
    ]);
  });

  test("an open task from an earlier session shows as a hint and stays where it is", async () => {
    fake.script([{ text: "a" }]);
    const { call, fresh, say } = await start();
    const old = await fresh();
    await say(old.session.id, "hi");
    await call("POST", `/v1/sessions/${old.session.id}/task`, { goal: "ship the parser" });

    const next = await fresh();
    expect(next.openTask).toEqual({ sessionId: old.session.id, goal: "ship the parser" });
    expect(next.task).toBeUndefined();
    const { sessions } = (await (
      await call("GET", `/v1/sessions?cwd=${encodeURIComponent(work)}`)
    ).json()) as { sessions: Array<{ id: string }> };
    expect(sessions.map((s) => s.id)).toContain(old.session.id);
  });

  test("no open task, no hint", async () => {
    fake.script([{ text: "a" }]);
    const { fresh, say } = await start();
    const old = await fresh();
    await say(old.session.id, "hi");
    expect((await fresh()).openTask).toBeUndefined();
  });
});

describe("--continue resumes the folder's latest session", () => {
  test("after a daemon restart, with its transcript and its model", async () => {
    fake.script([{ text: "a" }]);
    let { call, fresh, say, launch } = await start();
    const old = await fresh();
    await call("POST", `/v1/sessions/${old.session.id}/model`, { model: OTHER });
    await say(old.session.id, "hi");
    await daemon?.stop();

    ({ launch } = await start());
    const back = (await launch({ start: "continue" })).body;
    expect(back.session.id).toBe(old.session.id);
    expect(back.session.model).toBe(OTHER);
    expect(texts(back)).toEqual(["user: hi", "assistant: a"]);
  });

  test("the last conversation, not a newer chat nobody typed in", async () => {
    fake.script([{ text: "a" }]);
    const { fresh, say, launch } = await start();
    const old = await fresh();
    await say(old.session.id, "hi");
    await fresh();
    expect((await launch({ start: "continue" })).body.session.id).toBe(old.session.id);
  });

  test("the session prompted last, of two", async () => {
    fake.script([{ text: "a" }, { text: "b" }, { text: "c" }]);
    let { fresh, say, launch } = await start();
    const one = await fresh();
    await say(one.session.id, "one");
    const two = await fresh();
    await say(two.session.id, "two");
    await say(one.session.id, "one again");
    expect((await launch({ start: "continue" })).body.session.id).toBe(one.session.id);
    await daemon?.stop();
    ({ launch } = await start());
    expect((await launch({ start: "continue" })).body.session.id).toBe(one.session.id);
  });
});

describe("not set up", () => {
  test("a fresh launch with no model set up answers with the setup hint, not a 500", async () => {
    log?.close();
    daemon = await startDaemon({
      dataDir: dataDir(),
      port: 0,
      models: async () => {
        throw new NotSetUpError();
      },
      contextFiles: false,
      safety: async () => ({ allow: true as const }),
    });
    const token = readFileSync(dataPaths(dataDir()).token, "utf8").trim();
    const res = await fetch(`${daemon.url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd: work, start: "new" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(new NotSetUpError().message);
  });
});

describe("waking a session does not make it the latest", () => {
  test("a request that wakes an older session leaves --continue on the one prompted last", async () => {
    fake.script([{ text: "a" }, { text: "b" }]);
    const { call, fresh, say, launch } = await start();
    const older = await fresh();
    await say(older.session.id, "older");
    const newer = await fresh();
    await say(newer.session.id, "newer");
    await fresh(); // both sleep now
    expect((await call("GET", `/v1/sessions/${older.session.id}/status`)).status).toBe(200);
    expect((await launch({ start: "continue" })).body.session.id).toBe(newer.session.id);
  });

  test("an explicit --resume <id> does make it the latest", async () => {
    fake.script([{ text: "a" }, { text: "b" }]);
    const { fresh, say, launch } = await start();
    const older = await fresh();
    await say(older.session.id, "older");
    const newer = await fresh();
    await say(newer.session.id, "newer");
    await launch({ sessionId: older.session.id });
    expect((await launch({ start: "continue" })).body.session.id).toBe(older.session.id);
  });
});

describe("--resume <id> resumes that session", () => {
  test("live or from before a restart, even when it is not the latest", async () => {
    fake.script([{ text: "a" }, { text: "b" }]);
    let { fresh, say, launch } = await start();
    const one = await fresh();
    await say(one.session.id, "one");
    const two = await fresh();
    await say(two.session.id, "two");

    const back = (await launch({ sessionId: one.session.id })).body;
    expect(back.session.id).toBe(one.session.id);
    expect(texts(back)).toEqual(["user: one", "assistant: a"]);

    await daemon?.stop();
    ({ launch } = await start());
    const again = (await launch({ sessionId: one.session.id })).body;
    expect(again.session.id).toBe(one.session.id);
    expect(texts(again)).toEqual(["user: one", "assistant: a"]);
  });

  test("an unknown id is a 404, another folder's session a 400", async () => {
    fake.script([{ text: "a" }]);
    const { say, launch } = await start();
    expect((await launch({ sessionId: "nope" })).status).toBe(404);
    const other = join(home.dir, "other");
    mkdirSync(other);
    const s = (await launch({ start: "new" }, other)).body;
    await say(s.session.id, "hi");
    const res = await launch({ sessionId: s.session.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("another folder");
    expect((await launch({ start: "sideways" })).status).toBe(400);
  });
});

describe("a reconnect returns to the same session", () => {
  test("attaching by id gives back the session the client had, not the newest one", async () => {
    fake.script([{ text: "a" }]);
    let { fresh, say, launch } = await start();
    const mine = await fresh();
    await say(mine.session.id, "mine");
    await fresh();
    expect((await launch({ sessionId: mine.session.id })).body.session.id).toBe(mine.session.id);

    // A chat nobody typed in yet comes back as itself too, while the daemon runs.
    const empty = await fresh();
    await fresh();
    expect((await launch({ sessionId: empty.session.id })).body.session.id).toBe(empty.session.id);

    await daemon?.stop();
    ({ launch } = await start());
    expect((await launch({ sessionId: mine.session.id })).body.session.id).toBe(mine.session.id);
  });
});
