import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { writePlanLogin } from "../../test/support/plan-login.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import type { HamnessEvent, SafetyMode } from "../events/types.ts";
import { SessionHub } from "./session-hub.ts";

/** A fresh launch puts the folder's idle sessions to sleep; a request wakes them (ADR 0023). */

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let db: ReturnType<typeof openDatabase>;
let hub: SessionHub | undefined;
let published: HamnessEvent[] = [];

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir, "claude-opus-5-5", { otherModels: ["claude-haiku-5-5"] });
  db = openDatabase(join(home.dir, "hamness.sqlite"));
});
afterEach(() => {
  hub?.stop();
  hub = undefined;
  db.close();
  home.cleanup();
});

/** How many agents the hub started (each start asks for the models once). */
let starts = 0;
/** Set to make the next agent start fail. */
let startError: Error | undefined;

function startHub() {
  const modes = new Map<string, SafetyMode>();
  published = [];
  starts = 0;
  startError = undefined;
  hub = new SessionHub({
    db,
    dataDir: join(home.dir, "data"),
    models: async () => {
      starts += 1;
      if (startError) throw startError;
      return fake;
    },
    contextFiles: false,
    publish: (e) => published.push(e),
    safetyModes: {
      modeFor: (_cwd, id) => (id ? modes.get(id) : undefined) ?? "auto",
      setSessionMode: (id, mode) => (mode ? modes.set(id, mode) : modes.delete(id)),
    },
  });
  return hub;
}

const idle = (id: string) =>
  published.some(
    (e) => e.type === "agent.status" && "sessionId" in e && e.sessionId === id && !e.busy,
  );

async function until(pred: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!pred() && Date.now() < deadline) await Bun.sleep(5);
}

describe("sleeping sessions", () => {
  test("a fresh launch puts the folder's idle sessions to sleep, not other folders'", async () => {
    fake.script([{ text: "a" }]);
    const h = startHub();
    const other = join(home.dir, "other");
    mkdirSync(other);
    const elsewhere = await h.attach(other, { kind: "new" });
    const old = await h.attach(work, { kind: "new" });
    h.prompt(old.session.id, "hi");
    await until(() => idle(old.session.id));

    const next = await h.attach(work, { kind: "new" });
    expect(h.snapshot(old.session.id)).toBeUndefined();
    expect(h.snapshot(next.session.id)).toBeDefined();
    expect(h.snapshot(elsewhere.session.id)).toBeDefined();

    await h.ensureAwake(old.session.id);
    expect(h.snapshot(old.session.id)?.items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  test("a chat nobody typed in wakes with its model, thinking level and mode", async () => {
    const h = startHub();
    const empty = await h.attach(work, { kind: "new" });
    const id = empty.session.id;
    await h.setModel(id, "fake/claude-haiku-5-5");
    h.setMode(id, "ask");
    await h.attach(work, { kind: "new" });
    expect(h.snapshot(id)).toBeUndefined();

    await h.ensureAwake(id);
    expect(h.snapshot(id)?.session.model).toBe("fake/claude-haiku-5-5");
    expect(h.mode(id)).toEqual({ mode: "ask", source: "session" });
  });

  test("a busy session stays up", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fake.route(async () => {
      await gate;
      return { text: "done" };
    });
    const h = startHub();
    const busy = await h.attach(work, { kind: "new" });
    h.prompt(busy.session.id, "take your time");
    await h.attach(work, { kind: "new" });
    expect(h.snapshot(busy.session.id)?.session.busy).toBe(true);
    release();
    await until(() => idle(busy.session.id));
  });

  test("/resume of a session live in another window switches to it, with no second agent", async () => {
    fake.script([{ text: "a" }]);
    const h = startHub();
    const one = await h.attach(work, { kind: "new" });
    h.prompt(one.session.id, "hi");
    await until(() => idle(one.session.id));
    // A second window, `--continue`d onto the same session, and a third with a fresh chat.
    const fresh = await h.attach(work, { kind: "new" });
    await h.attach(work, { kind: "session", id: one.session.id });
    const back = await h.resume(fresh.session.id, one.session.id);
    expect(back.session.id).toBe(one.session.id);
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "session.replaced",
        sessionId: fresh.session.id,
        newSessionId: one.session.id,
      }),
    );
    const list = await h.listSessions(work, one.session.id);
    expect(list.filter((s) => s.current).map((s) => s.id)).toEqual([one.session.id]);
  });
});

describe("review fixes", () => {
  /** A prompted session, then a fresh launch that puts it to sleep. */
  async function sleeping(h: SessionHub) {
    fake.script([{ text: "a" }]);
    const old = await h.attach(work, { kind: "new" });
    h.prompt(old.session.id, "hi");
    await until(() => idle(old.session.id));
    const fresh = await h.attach(work, { kind: "new" });
    expect(h.snapshot(old.session.id)).toBeUndefined();
    return { old: old.session.id, fresh: fresh.session.id };
  }

  test("/resume racing a wake starts one agent for the id, whichever comes first", async () => {
    const h = startHub();
    const { old, fresh } = await sleeping(h);
    const before = starts;
    await Promise.all([h.resume(fresh, old), h.ensureAwake(old)]);
    expect(starts - before).toBe(1);
    expect(h.snapshot(old)).toBeDefined();

    const again = await h.attach(work, { kind: "new" });
    expect(h.snapshot(old)).toBeUndefined();
    const before2 = starts;
    await Promise.all([h.ensureAwake(old), h.resume(again.session.id, old)]);
    expect(starts - before2).toBe(1);
  });

  test("a wake already under way still checks the folder", async () => {
    const h = startHub();
    const { old } = await sleeping(h);
    const other = join(home.dir, "other");
    mkdirSync(other);
    const waking = h.ensureAwake(old);
    await expect(h.attach(other, { kind: "session", id: old })).rejects.toThrow(/another folder/);
    await waking;
  });

  test("a session switching models is not put to sleep", async () => {
    const h = startHub();
    const s = await h.attach(work, { kind: "new" });
    const switching = h.setModel(s.session.id, "fake/claude-haiku-5-5");
    const next = h.attach(work, { kind: "new" });
    expect(h.snapshot(s.session.id)).toBeDefined();
    await Promise.all([switching, next]);
  });

  test("a session whose SessionStart hooks still run is not put to sleep", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = startHub();
    hub?.stop();
    hub = new SessionHub({
      db,
      dataDir: join(home.dir, "data"),
      models: async () => fake,
      contextFiles: false,
      publish: () => {},
      hooks: {
        sessionStart: async () => {
          await gate;
          return {};
        },
      } as unknown as NonNullable<ConstructorParameters<typeof SessionHub>[0]["hooks"]>,
    });
    void h;
    const s = await hub.attach(work, { kind: "new" });
    await hub.attach(work, { kind: "new" }).catch(() => undefined);
    expect(hub.snapshot(s.session.id)).toBeDefined();
    release();
  });

  test("a wake that fails for another reason than a missing session is not swallowed", async () => {
    const h = startHub();
    const { old } = await sleeping(h);
    startError = new Error("disk on fire");
    await expect(h.ensureAwake(old)).rejects.toThrow("disk on fire");
    await h.ensureAwake("nope");
  });
});

describe("what the TUI's /resume and /status read", () => {
  test("listed sessions carry when they were picked (the -c order) and their plan calls", async () => {
    fake.script([{ text: "a" }, { text: "b" }]);
    const h = startHub();
    const one = await h.attach(work, { kind: "new" });
    h.prompt(one.session.id, "first");
    await until(() => idle(one.session.id));
    const two = await h.attach(work, { kind: "new" });
    h.prompt(two.session.id, "second");
    await until(() => idle(two.session.id));
    // Back to the first: it is the folder's latest again, though the second was active last.
    await h.resume(two.session.id, one.session.id);
    const list = await h.listSessions(work, one.session.id);
    const at = (id: string) => list.find((s) => s.id === id);
    expect(at(one.session.id)?.pickedAt).toBeGreaterThan(at(two.session.id)?.pickedAt ?? 0);
    expect(at(one.session.id)?.planCalls).toBe(0);
  });

  test("/status names the ChatGPT plan tier only for a session on the plan", async () => {
    writePlanLogin(join(home.dir, "data"), { tier: "team" });
    const h = startHub();
    const api = await h.attach(work, { kind: "new" });
    expect(h.status(api.session.id).planTier).toBeUndefined();
    fake.billing = () => ({ kind: "plan" });
    const plan = await h.attach(work, { kind: "new" });
    expect(h.status(plan.session.id).planTier).toBe("team");
  });
});
