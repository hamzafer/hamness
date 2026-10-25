import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot, TranscriptItem } from "../events/types.ts";
import { listTasks } from "../stats/index.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

/** The slash-command endpoints: new, resume, fork, compact, status, thinking, name, export, mode. */

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let daemon: RunningDaemon | undefined;
let log: Awaited<ReturnType<typeof eventLog>> | undefined;

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir, "claude-opus-5-5", { reasoning: true });
});
afterEach(async () => {
  log?.close();
  log = undefined;
  await daemon?.stop();
  daemon = undefined;
  home.cleanup();
});

const dataDir = () => join(home.dir, "data");

/** `rules`: the real safety service (modes, decisions); otherwise every call is allowed. */
async function start(opts: { rules?: boolean } = {}) {
  log?.close();
  daemon = await startDaemon({
    dataDir: dataDir(),
    port: 0,
    models: async () => fake,
    contextFiles: false,
    ...(opts.rules ? {} : { safety: async () => ({ allow: true as const }) }),
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
  const attach = async () =>
    (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
  /** Sends a prompt and waits for the run to settle. */
  const say = async (sessionId: string, text: string) => {
    const res = await call("POST", `/v1/sessions/${sessionId}/prompt`, { text });
    expect(res.status).toBe(202);
    const { messageId } = (await res.json()) as { messageId: string };
    await l.waitFor(
      (e) =>
        e.type === "agent.status" &&
        e.sessionId === sessionId &&
        !e.busy &&
        (e as { seq: number }).seq > (lastSeq(sessionId, messageId) ?? 0),
    );
    return messageId;
  };
  const lastSeq = (sessionId: string, messageId: string) =>
    l
      .ofType("agent.message.start")
      .find((e) => e.sessionId === sessionId && e.messageId === messageId)?.seq;
  return { d, log: l, call, attach, say };
}

const lines = (items: TranscriptItem[]) =>
  items.map((i) => (i.kind === "message" ? `${i.role}: ${i.text}` : `tool: ${i.tool}`));

describe("new session (/new, /clear)", () => {
  test("ends the old session and returns a fresh one in the same cwd", async () => {
    fake.script([{ text: "hello" }]);
    const { d, call, attach, say, log } = await start();
    const s = await attach();
    await say(s.session.id, "hi");

    const res = await call("POST", `/v1/sessions/${s.session.id}/new`, {});
    expect(res.status).toBe(200);
    const next = (await res.json()) as SessionSnapshot;
    expect(next.session.id).not.toBe(s.session.id);
    expect(next.session.cwd).toBe(work);
    expect(next.items).toEqual([]);

    const replaced = await log.waitFor((e) => e.type === "session.replaced");
    expect(replaced).toMatchObject({
      sessionId: s.session.id,
      newSessionId: next.session.id,
      reason: "new",
    });
    expect((await call("GET", `/v1/sessions/${s.session.id}`)).status).toBe(404);
    expect((await attach()).session.id).toBe(next.session.id);

    const old = d.db.sqlite
      .query<{ ended_at: number | null; status: string }, [string]>(
        `SELECT s.ended_at, a.status FROM sessions s JOIN agents a ON a.session_id = s.id
         WHERE s.id = ?`,
      )
      .get(s.session.id);
    expect(old?.ended_at).not.toBeNull();
    expect(old?.status).toBe("done");
    // The new session is stored on its first prompt, like any other.
    const n = d.db.sqlite
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sessions WHERE id = ?")
      .get(next.session.id);
    expect(n?.n).toBe(0);
  });

  test("an open explicit task moves to the new session (ADR 0021)", async () => {
    const { d, call, attach } = await start();
    const s = await attach();
    const opened = await call("POST", `/v1/sessions/${s.session.id}/task`, { goal: "fix it" });
    const { task } = (await opened.json()) as { task: { id: string } };

    const next = (await (
      await call("POST", `/v1/sessions/${s.session.id}/new`, {})
    ).json()) as SessionSnapshot;
    expect(next.task).toMatchObject({ id: task.id, goal: "fix it", outcome: "open" });
    const row = d.db.sqlite
      .query<{ session_id: string }, [string]>("SELECT session_id FROM tasks WHERE id = ?")
      .get(task.id);
    expect(row?.session_id).toBe(next.session.id);
  });

  test("is refused while the session runs", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    fake.route(async () => {
      await held;
      return { text: "done" };
    });
    const { call, attach, log } = await start();
    const s = await attach();
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "slow" });
    expect((await call("POST", `/v1/sessions/${s.session.id}/new`, {})).status).toBe(409);
    release();
    await log.waitFor((e) => e.type === "agent.status" && !e.busy);
  });

  test("an unknown session is a 404", async () => {
    const { call } = await start();
    expect((await call("POST", "/v1/sessions/nope/new", {})).status).toBe(404);
  });
});

describe("list and resume", () => {
  test("lists the cwd's sessions and resumes one by id, context included", async () => {
    fake.script([{ text: "The word is fig." }, { text: "other" }, { text: "You asked the word." }]);
    const { call, attach, say } = await start();
    const first = await attach();
    await say(first.session.id, "what is the word?");
    const second = (await (
      await call("POST", `/v1/sessions/${first.session.id}/new`, {})
    ).json()) as SessionSnapshot;
    await say(second.session.id, "something else");

    const listed = await call("GET", `/v1/sessions?cwd=${encodeURIComponent(work)}`);
    expect(listed.status).toBe(200);
    const { sessions } = (await listed.json()) as {
      sessions: Array<{
        id: string;
        messageCount: number;
        costMicros: number;
        current: boolean;
        resumable: boolean;
        startedAt: number;
        lastActivityAt: number;
      }>;
    };
    expect(sessions.map((s) => s.id)).toEqual([second.session.id, first.session.id]);
    expect(sessions.map((s) => s.current)).toEqual([true, false]);
    expect(sessions.every((s) => s.messageCount === 2 && s.costMicros > 0 && s.resumable)).toBe(
      true,
    );
    expect(sessions[0]?.lastActivityAt).toBeGreaterThanOrEqual(sessions[0]?.startedAt ?? 0);

    const res = await call("POST", `/v1/sessions/${second.session.id}/resume`, {
      sessionId: first.session.id,
    });
    expect(res.status).toBe(200);
    const back = (await res.json()) as SessionSnapshot;
    expect(back.session.id).toBe(first.session.id);
    expect(lines(back.items)).toEqual(["user: what is the word?", "assistant: The word is fig."]);
    expect((await attach()).session.id).toBe(first.session.id);

    await say(first.session.id, "what did I ask?");
    const context = JSON.stringify(fake.contexts.at(-1)?.messages);
    expect(context).toContain("The word is fig.");
    expect(context).not.toContain("something else");
  });

  test("resume refuses unknown ids and sessions of another cwd", async () => {
    fake.script([{ text: "x" }]);
    const { call, attach, say } = await start();
    const other = join(home.dir, "other");
    mkdirSync(other);
    const o = (await (
      await call("POST", "/v1/sessions", { cwd: other })
    ).json()) as SessionSnapshot;
    await say(o.session.id, "hi there");
    const s = await attach();
    const resume = (sessionId: unknown) =>
      call("POST", `/v1/sessions/${s.session.id}/resume`, { sessionId });
    expect((await resume("nope")).status).toBe(404);
    expect((await resume(o.session.id)).status).toBe(400);
    expect((await resume(42)).status).toBe(400);
  });

  test("listing needs an absolute cwd", async () => {
    const { call } = await start();
    expect((await call("GET", "/v1/sessions")).status).toBe(400);
    expect((await call("GET", "/v1/sessions?cwd=relative")).status).toBe(400);
  });
});

describe("status, thinking and name", () => {
  test("status reports the model, thinking, context, tokens, cost, task and mode", async () => {
    fake.script([{ text: "hi", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } }]);
    const { call, attach, say } = await start({ rules: true });
    const s = await attach();
    await say(s.session.id, "hello");
    const res = await call("GET", `/v1/sessions/${s.session.id}/status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      sessionId: s.session.id,
      cwd: work,
      model: "fake/claude-opus-5-5",
      thinkingLevel: "medium",
      busy: false,
      mode: "auto",
      modeSource: "config",
      judge: "no-key",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 },
      messages: { user: 1, assistant: 1 },
    });
    expect(status.costMicros).toBeGreaterThan(0);
    expect(status.context).toMatchObject({ contextWindow: expect.any(Number) });
    expect(status.task).toBeUndefined(); // a chat turn with no evidence or edits is dropped
    expect(status.branch).toBeUndefined(); // not a git repo
  });

  test("thinking level get and set, with Pi's levels for the model", async () => {
    const { d, call, attach, log, say } = await start();
    fake.script([{ text: "ok" }]);
    const s = await attach();
    const got = (await (await call("GET", `/v1/sessions/${s.session.id}/thinking`)).json()) as {
      level: string;
      levels: string[];
    };
    expect(got.level).toBe("medium");
    expect(got.levels).toContain("high");
    expect(got.levels).toContain("off");

    const set = await call("POST", `/v1/sessions/${s.session.id}/thinking`, { level: "high" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { level: string }).level).toBe("high");
    await log.waitFor((e) => e.type === "agent.thinking" && e.level === "high");
    expect((await attach()).session.thinkingLevel).toBe("high");
    expect(
      (await call("POST", `/v1/sessions/${s.session.id}/thinking`, { level: "huge" })).status,
    ).toBe(400);

    await say(s.session.id, "hi");
    const row = d.db.sqlite
      .query<{ thinking_level: string | null }, [string]>(
        "SELECT thinking_level FROM sessions WHERE id = ?",
      )
      .get(s.session.id);
    expect(row?.thinking_level).toBe("high");
  });

  test("rename: stored, in the snapshot, the list and the dashboard's task rows", async () => {
    fake.script([{ text: "ok" }]);
    const { d, call, attach, log, say } = await start();
    const s = await attach();
    await call("POST", `/v1/sessions/${s.session.id}/task`, { goal: "parser" });
    await say(s.session.id, "hi");
    const res = await call("POST", `/v1/sessions/${s.session.id}/name`, { name: "  parser fix " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionSnapshot).session.name).toBe("parser fix");
    await log.waitFor((e) => e.type === "session.name" && e.name === "parser fix");
    expect((await attach()).session.name).toBe("parser fix");

    const listed = (await (
      await call("GET", `/v1/sessions?cwd=${encodeURIComponent(work)}`)
    ).json()) as { sessions: Array<{ name?: string }> };
    expect(listed.sessions[0]?.name).toBe("parser fix");
    const page = listTasks(d.db.sqlite, { range: "24h", now: Date.now() });
    expect(page.rows[0]?.sessionName).toBe("parser fix");

    expect((await call("POST", `/v1/sessions/${s.session.id}/name`, { name: " " })).status).toBe(
      400,
    );
    expect(
      (await call("POST", `/v1/sessions/${s.session.id}/name`, { name: "x".repeat(201) })).status,
    ).toBe(400);
  });
});

describe("fork", () => {
  test("a new session with the history before a user message; the message comes back as a draft", async () => {
    fake.script([{ text: "first reply" }, { text: "second reply" }, { text: "forked reply" }]);
    const { call, attach, say, log } = await start();
    const s = await attach();
    await say(s.session.id, "one");
    const two = await say(s.session.id, "two");

    const res = await call("POST", `/v1/sessions/${s.session.id}/fork`, { messageId: two });
    expect(res.status).toBe(201);
    const { snapshot, text } = (await res.json()) as { snapshot: SessionSnapshot; text: string };
    expect(text).toBe("two");
    expect(snapshot.session.id).not.toBe(s.session.id);
    expect(lines(snapshot.items)).toEqual(["user: one", "assistant: first reply"]);
    await log.waitFor((e) => e.type === "session.replaced" && e.reason === "fork");

    await say(snapshot.session.id, "three");
    const context = JSON.stringify(fake.contexts.at(-1)?.messages);
    expect(context).toContain("first reply");
    expect(context).not.toContain("second reply");
    // Copied rows do not count twice: only the forked session's own model call is its cost.
    const status = (await (
      await call("GET", `/v1/sessions/${snapshot.session.id}/status`)
    ).json()) as { messages: { user: number }; tokens: { total: number } };
    expect(status.tokens.total).toBe(15);
  });

  test("from the first message: an empty session", async () => {
    fake.script([{ text: "first reply" }]);
    const { call, attach, say } = await start();
    const s = await attach();
    const one = await say(s.session.id, "one");
    const res = await call("POST", `/v1/sessions/${s.session.id}/fork`, { messageId: one });
    expect(res.status).toBe(201);
    const { snapshot, text } = (await res.json()) as { snapshot: SessionSnapshot; text: string };
    expect(text).toBe("one");
    expect(snapshot.items).toEqual([]);
  });

  test("an unknown or assistant message is a 400", async () => {
    fake.script([{ text: "reply" }]);
    const { call, attach, say, log } = await start();
    const s = await attach();
    await say(s.session.id, "one");
    const reply = log.ofType("agent.message.end").find((e) => e.role === "assistant");
    const fork = (messageId: unknown) =>
      call("POST", `/v1/sessions/${s.session.id}/fork`, { messageId });
    expect((await fork("nope")).status).toBe(400);
    expect((await fork(reply?.messageId)).status).toBe(400);
    expect((await fork(undefined)).status).toBe(400);
  });
});

describe("export and last reply", () => {
  test("export to HTML under the data dir by default, and JSONL at a path", async () => {
    fake.script([{ text: "the reply" }]);
    const { call, attach, say } = await start();
    const s = await attach();
    await say(s.session.id, "hello");

    const html = await call("POST", `/v1/sessions/${s.session.id}/export`, { format: "html" });
    expect(html.status).toBe(200);
    const { path } = (await html.json()) as { path: string };
    expect(path.startsWith(join(dataDir(), "exports"))).toBe(true);
    expect(path.endsWith(".html")).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("<html");

    const target = join(work, "out.jsonl");
    const jsonl = await call("POST", `/v1/sessions/${s.session.id}/export`, {
      format: "jsonl",
      path: "out.jsonl",
    });
    expect(jsonl.status).toBe(200);
    expect(((await jsonl.json()) as { path: string }).path).toBe(target);
    expect(readFileSync(target, "utf8")).toContain("the reply");

    // An existing file is not overwritten unless asked.
    const again = () =>
      call("POST", `/v1/sessions/${s.session.id}/export`, { format: "jsonl", path: target });
    expect((await again()).status).toBe(409);
    expect(
      (
        await call("POST", `/v1/sessions/${s.session.id}/export`, {
          format: "jsonl",
          path: target,
          overwrite: true,
        })
      ).status,
    ).toBe(200);
  });

  test("export refuses a bad format or a missing folder", async () => {
    fake.script([{ text: "r" }]);
    const { call, attach, say } = await start();
    const s = await attach();
    await say(s.session.id, "hello");
    const exp = (body: unknown) => call("POST", `/v1/sessions/${s.session.id}/export`, body);
    expect((await exp({ format: "pdf" })).status).toBe(400);
    expect((await exp({ format: "html", path: join(work, "missing", "x.html") })).status).toBe(400);
    expect(existsSync(join(work, "missing"))).toBe(false);
  });

  test("the last assistant message text, for /copy", async () => {
    fake.script([{ text: "copy **me**" }]);
    const { call, attach, say } = await start();
    const s = await attach();
    expect((await call("GET", `/v1/sessions/${s.session.id}/last-reply`)).status).toBe(404);
    await say(s.session.id, "hello");
    const res = await call("GET", `/v1/sessions/${s.session.id}/last-reply`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "copy **me**" });
  });
});

describe("safety mode per session", () => {
  test("get and set ask, auto, yolo; yolo is loud and decides the calls", async () => {
    fake.script([
      { tools: [{ name: "bash", args: { command: "echo hi > note.txt" } }] },
      { text: "done" },
    ]);
    const { d, call, attach, say, log } = await start({ rules: true });
    const s = await attach();
    const get = async () =>
      (await (await call("GET", `/v1/sessions/${s.session.id}/mode`)).json()) as {
        mode: string;
        source: string;
      };
    expect(await get()).toEqual({ mode: "auto", source: "config" });

    const res = await call("POST", `/v1/sessions/${s.session.id}/mode`, { mode: "yolo" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "yolo", source: "session" });
    const ev = (await log.waitFor((e) => e.type === "safety.mode")) as Extract<
      HamnessEvent,
      { type: "safety.mode" }
    >;
    expect(ev.mode).toBe("yolo");
    expect(ev.warning).toMatch(/every tool call/i);
    expect((await attach()).session.mode).toBe("yolo");

    await say(s.session.id, "write a note");
    const decision = d.db.sqlite
      .query<{ source: string; mode: string }, [string]>(
        "SELECT source, mode FROM decisions WHERE session_id = ? AND tool = 'bash'",
      )
      .get(s.session.id);
    expect(decision).toEqual({ source: "mode", mode: "yolo" });
    const row = d.db.sqlite
      .query<{ safety_mode: string | null }, [string]>(
        "SELECT safety_mode FROM sessions WHERE id = ?",
      )
      .get(s.session.id);
    expect(row?.safety_mode).toBe("yolo");

    expect(
      (await call("POST", `/v1/sessions/${s.session.id}/mode`, { mode: "reckless" })).status,
    ).toBe(400);
    await call("POST", `/v1/sessions/${s.session.id}/mode`, { mode: "ask" });
    expect(await get()).toEqual({ mode: "ask", source: "session" });
  });

  test("the mode survives a daemon restart with the session", async () => {
    fake.script([{ text: "ok" }]);
    let { call, attach, say } = await start({ rules: true });
    const s = await attach();
    await call("POST", `/v1/sessions/${s.session.id}/mode`, { mode: "ask" });
    await say(s.session.id, "hi");
    await daemon?.stop();
    ({ call, attach } = await start({ rules: true }));
    const back = await attach();
    expect(back.session.id).toBe(s.session.id);
    expect(back.session.mode).toBe("ask");
  });
});

describe("compact", () => {
  test("summarizes older turns and reports the context size before and after", async () => {
    // Pi keeps ~20k recent tokens, so two big turns leave the first one to summarize.
    const big = (tag: string) => `${tag} ${"lorem ipsum dolor ".repeat(6000)}`;
    // Pi reads the context size from the last reply's usage: make it the size of two turns.
    const usage = { input: 60_000, output: 5, cacheRead: 0, cacheWrite: 0 };
    fake.script([
      { text: "r1", usage: { ...usage, input: 30_000 } },
      { text: "r2", usage },
      { text: "SUMMARY of the work" },
    ]);
    const { call, attach, say, log } = await start();
    const s = await attach();
    await say(s.session.id, big("first"));
    await say(s.session.id, big("second"));

    const res = await call("POST", `/v1/sessions/${s.session.id}/compact`, {
      instructions: "keep the word fig",
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { tokensBefore: number; tokensAfter: number };
    expect(out.tokensBefore).toBeGreaterThan(out.tokensAfter);
    const startEv = await log.waitFor((e) => e.type === "agent.compaction.start");
    expect(startEv).toMatchObject({ reason: "manual" });
    const end = await log.waitFor((e) => e.type === "agent.compaction.end");
    expect(end).toMatchObject({ reason: "manual", aborted: false, tokensBefore: out.tokensBefore });
    const summaryCall = JSON.stringify(fake.contexts.at(-1));
    expect(summaryCall).toContain("keep the word fig");
    // The summary call is spend too: a model call with no reply message.
    const calls = daemon?.db.sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM model_calls WHERE session_id = ? AND message_id IS NULL",
      )
      .get(s.session.id);
    expect(calls?.n).toBe(1);
  });

  test("a session too small to compact is a 409 with Pi's reason", async () => {
    fake.script([{ text: "r1" }]);
    const { call, attach, say } = await start();
    const s = await attach();
    await say(s.session.id, "hi");
    const res = await call("POST", `/v1/sessions/${s.session.id}/compact`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing to compact/i);
  });
});

describe("skills and MCP servers", () => {
  test("lists what the session loaded (none without Claude Code compatibility)", async () => {
    const { call, attach } = await start();
    const s = await attach();
    const res = await call("GET", `/v1/sessions/${s.session.id}/compat`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [], mcpServers: [] });
  });

  test("with compatibility on, a skill from hamness's skill folder is listed", async () => {
    const skill = join(dataDir(), "skills", "release-notes");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: release-notes\ndescription: Write release notes\n---\nSteps.\n",
    );
    daemon = await startDaemon({
      dataDir: dataDir(),
      port: 0,
      models: async () => fake,
      safety: async () => ({ allow: true }),
    });
    const token = readFileSync(dataPaths(dataDir()).token, "utf8").trim();
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${daemon?.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const body = (await (await call("GET", `/v1/sessions/${s.session.id}/compat`)).json()) as {
      skills: Array<{ name: string; description: string; scope: string }>;
    };
    expect(body.skills).toContainEqual(
      expect.objectContaining({
        name: "release-notes",
        description: "Write release notes",
        scope: "user",
      }),
    );
  });
});
