import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import type { SafetyMode } from "../events/types.ts";
import { SessionBusyError, SessionHub } from "./session-hub.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let db: ReturnType<typeof openDatabase>;
let hub: SessionHub | undefined;

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir, "claude-opus-5-5", { reasoning: true });
  db = openDatabase(join(home.dir, "hamness.sqlite"));
});
afterEach(() => {
  hub?.stop();
  hub = undefined;
  db.close();
  home.cleanup();
});

function startHub() {
  const modes = new Map<string, SafetyMode>();
  hub = new SessionHub({
    db,
    dataDir: join(home.dir, "data"),
    models: async () => fake,
    contextFiles: false,
    publish: () => {},
    safetyModes: {
      modeFor: (_cwd, id) => (id ? modes.get(id) : undefined) ?? "auto",
      setSessionMode: (id, mode) => (mode ? modes.set(id, mode) : modes.delete(id)),
    },
  });
  return hub;
}

describe("settings while the session is being replaced or compacted", () => {
  test("mode, thinking and name are refused (busy) while /new replaces the session", async () => {
    const h = startHub();
    const s = await h.attach(work);
    const id = s.session.id;
    const replacing = h.newSession(id);
    expect(() => h.setMode(id, "ask")).toThrow(SessionBusyError);
    expect(() => h.setThinking(id, "high")).toThrow(SessionBusyError);
    expect(() => h.rename(id, "x")).toThrow(SessionBusyError);
    await replacing;
  });

  test("thinking is refused while compacting", async () => {
    const h = startHub();
    const s = await h.attach(work);
    const compacting = h.compact(s.session.id).catch(() => undefined);
    expect(() => h.setThinking(s.session.id, "high")).toThrow(SessionBusyError);
    await compacting;
  });
});
