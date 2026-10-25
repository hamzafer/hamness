import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import type { HamnessEvent, SafetyMode } from "../events/types.ts";
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

let published: HamnessEvent[] = [];

function startHub() {
  const modes = new Map<string, SafetyMode>();
  published = [];
  hub = new SessionHub({
    db,
    dataDir: join(home.dir, "data"),
    models: async () => fake,
    contextFiles: false,
    publish: (e) => published.push(e),
    safetyModes: {
      modeFor: (_cwd, id) => (id ? modes.get(id) : undefined) ?? "auto",
      setSessionMode: (id, mode) => (mode ? modes.set(id, mode) : modes.delete(id)),
    },
  });
  return hub;
}

describe("compat info", () => {
  test("a started MCP server reports how many tools it registered", async () => {
    const claudeHome = join(home.dir, "claude-home");
    mkdirSync(claudeHome);
    const server = resolve(import.meta.dir, "../../test/support/mcp-server.ts");
    writeFileSync(
      join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [server] } },
      }),
    );
    fake.script([{ text: "Hi." }]);
    hub = new SessionHub({
      db,
      dataDir: join(home.dir, "data"),
      models: async () => fake,
      claude: { env: { HOME: claudeHome }, managedDir: join(home.dir, "managed") },
      publish: () => {},
    });
    const s = await hub.attach(work);
    hub.prompt(s.session.id, "hello");
    let info = hub.compatInfo(s.session.id);
    for (let i = 0; i < 100 && !info.mcpServers[0]?.tools; i++) {
      await Bun.sleep(20);
      info = hub.compatInfo(s.session.id);
    }
    expect(info.mcpServers).toEqual([{ name: "echo", scope: "user", status: "start", tools: 1 }]);
  });
});

describe("event numbers across a resume", () => {
  test("a resumed session's seq goes on from its last life, so no client drops its events", async () => {
    fake.script([{ text: "The word is fig." }]);
    const h = startHub();
    const first = await h.attach(work);
    const id = first.session.id;
    h.prompt(id, "what is the word?");
    const deadline = Date.now() + 5000;
    while (
      !published.some((e) => e.type === "agent.status" && "sessionId" in e && !e.busy) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    const lastSeq = () =>
      Math.max(
        0,
        ...published.flatMap((e) => ("sessionId" in e && e.sessionId === id ? [e.seq] : [])),
      );
    const before = lastSeq();
    expect(before).toBeGreaterThan(3);
    const next = await h.newSession(id);
    const back = await h.resume(next.session.id, id);
    expect(back.session.id).toBe(id);
    expect(back.seq).toBeGreaterThanOrEqual(before);
    h.rename(id, "again");
    const renamed = published.findLast(
      (e) => e.type === "session.name" && "sessionId" in e && e.sessionId === id,
    );
    expect(renamed && "seq" in renamed ? renamed.seq : 0).toBeGreaterThan(before);
  });
});

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
