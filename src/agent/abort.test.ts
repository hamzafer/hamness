import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import type { AgentEvent } from "../events/types.ts";
import { SessionHub } from "./session-hub.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let db: ReturnType<typeof openDatabase>;
let hub: SessionHub | undefined;
let events: AgentEvent[];

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir);
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  events = [];
});
afterEach(() => {
  hub?.stop();
  hub = undefined;
  db.close();
  home.cleanup();
});

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out; events: ${events.map((e) => e.type).join(", ")}`);
    }
    await Bun.sleep(5);
  }
}

describe("stopping a run", () => {
  test("a user stop ends the reply as stopped, not as an error", async () => {
    const gate = Promise.withResolvers<void>();
    let calling = false;
    fake.route(async () => {
      calling = true;
      await gate.promise;
      return { text: "too late" };
    });
    hub = new SessionHub({
      db,
      dataDir: join(home.dir, "data"),
      models: async () => fake,
      contextFiles: false,
      publish: (e) => events.push(e),
    });
    const snap = await hub.attach(work);
    const id = snap.session.id;
    hub.prompt(id, "go");
    await until(() => calling);
    const stopping = hub.abort(id);
    gate.resolve();
    await stopping;
    await until(() => events.some((e) => e.type === "agent.status" && !e.busy));

    const ends = events.filter((e) => e.type === "agent.message.end" && e.role === "assistant");
    expect(ends.length).toBeGreaterThan(0);
    for (const e of ends) expect(e).not.toHaveProperty("error");
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    // The stop is announced, before the run's last status.
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.stopped");
    expect(types.lastIndexOf("agent.stopped")).toBeLessThan(types.lastIndexOf("agent.status"));
  });
});
