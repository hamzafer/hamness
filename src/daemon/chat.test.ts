import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import type { SafetyCheck } from "../safety/index.ts";
import { kpis } from "../stats/index.ts";
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
  fake = await fakeModel(home.dir);
});
afterEach(async () => {
  log?.close();
  log = undefined;
  await daemon?.stop();
  daemon = undefined;
  home.cleanup();
});

async function start(safety?: SafetyCheck) {
  daemon = await startDaemon({
    dataDir: join(home.dir, "data"),
    port: 0,
    models: async () => fake,
    contextFiles: false,
    ...(safety ? { safety } : {}),
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

describe("sessions API", () => {
  test("attaching to a cwd creates a session, and attaching again returns the same one", async () => {
    const { call } = await start();
    const first = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(first.session.cwd).toBe(work);
    expect(first.session.model).toBe("fake/claude-opus-5-5");
    expect(first.items).toEqual([]);

    const again = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(again.session.id).toBe(first.session.id);

    const other = join(home.dir, "other");
    mkdirSync(other);
    const third = (await (
      await call("POST", "/v1/sessions", { cwd: other })
    ).json()) as SessionSnapshot;
    expect(third.session.id).not.toBe(first.session.id);
  });

  test("a cwd that is not an existing absolute directory is a 400", async () => {
    const { call } = await start();
    expect((await call("POST", "/v1/sessions", { cwd: "relative/dir" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { cwd: join(work, "missing") })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", {})).status).toBe(400);
  });

  test("an unknown session is a 404", async () => {
    const { call } = await start();
    expect((await call("GET", "/v1/sessions/nope")).status).toBe(404);
    expect((await call("POST", "/v1/sessions/nope/prompt", { text: "hi" })).status).toBe(404);
  });

  test("an empty prompt is a 400", async () => {
    const { call } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    expect((await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "  " })).status).toBe(
      400,
    );
  });
});

describe("a prompt, end to end with a fake model", () => {
  test("with no API key, the reply says how to set one", async () => {
    fake = await fakeModel(home.dir, "claude-opus-5-5", { noKey: true });
    fake.script([{ text: "never sent" }]);
    const { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "hi" });
    await log.waitFor(settled(s.session.id));
    const messages = log.events.flatMap((e) =>
      e.type === "agent.message.end" && e.error
        ? [e.error]
        : e.type === "agent.error"
          ? [e.message]
          : [],
    );
    expect(messages.join(" ")).toContain("FAKE_API_KEY");
    expect(messages.join(" ")).toContain("keys.json");
    expect(messages.join(" ")).not.toContain("/login");
    expect(fake.calls).toBe(0);
  });

  test("streams the reply and a compact tool call over the event stream", async () => {
    writeFileSync(join(work, "notes.txt"), "the word is fig\n");
    fake.script([
      {
        text: "Let me read it.",
        tools: [{ name: "read", args: { path: "notes.txt" } }],
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 },
      },
      { text: "The word is fig.", usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const id = s.session.id;

    const res = await call("POST", `/v1/sessions/${id}/prompt`, { text: "what is the word?" });
    expect(res.status).toBe(202);
    await log.waitFor(settled(id));

    const ends = log.ofType("agent.message.end").filter((e) => e.sessionId === id);
    expect(ends.map((e) => [e.role, e.text])).toEqual([
      ["user", "what is the word?"],
      ["assistant", "Let me read it."],
      ["assistant", "The word is fig."],
    ]);
    const lastReply = ends[2];
    const deltas = log
      .ofType("agent.message.delta")
      .filter((e) => e.messageId === lastReply?.messageId)
      .map((e) => e.text);
    expect(deltas.join("")).toBe("The word is fig.");

    const [toolStart] = log.ofType("agent.tool.start");
    expect(toolStart).toMatchObject({ tool: "read", args: { path: "notes.txt" } });
    expect(toolStart?.messageId).toBe(ends[1]?.messageId as string);
    const [toolEnd] = log.ofType("agent.tool.end");
    expect(toolEnd).toMatchObject({ toolCallId: toolStart?.toolCallId, status: "ok" });

    const usage = log.ofType("agent.usage");
    // 100*4 + 20*20 + 5*0.2 + 7*5 = 836; 50*4 + 10*20 = 400 (Opus 5.5 prices, micro-dollars)
    expect(usage.map((u) => u.costMicros)).toEqual([836, 400]);
    expect(usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, priced: true });

    const seqs = log.events.flatMap((e) => ("seq" in e && e.sessionId === id ? [e.seq] : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("stores messages, tool calls and model-call usage and cost in SQLite", async () => {
    writeFileSync(join(work, "notes.txt"), "fig\n");
    fake.script([
      {
        tools: [{ name: "read", args: { path: "notes.txt" } }],
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 },
      },
      { text: "fig", usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
    const { d, call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const id = s.session.id;
    await call("POST", `/v1/sessions/${id}/prompt`, { text: "word?" });
    await log.waitFor(settled(id));

    const q = <T>(sql: string) => d.db.sqlite.query<T, [string]>(sql).all(id);
    expect(q("SELECT source, cwd, model FROM sessions WHERE id = ?")).toEqual([
      { source: "hamness", cwd: work, model: "fake/claude-opus-5-5" },
    ]);
    expect(q("SELECT kind FROM agents WHERE session_id = ?")).toEqual([{ kind: "main" }]);
    expect(q("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id")).toEqual([
      { role: "user", content: "word?" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "fig" },
    ]);
    expect(
      q("SELECT tool, args_json, status, result_summary FROM tool_calls WHERE session_id = ?"),
    ).toEqual([
      { tool: "read", args_json: '{"path":"notes.txt"}', status: "ok", result_summary: "fig" },
    ]);
    expect(
      q(
        `SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros
         FROM model_calls WHERE session_id = ? ORDER BY id`,
      ),
    ).toEqual([
      {
        provider: "fake",
        model: "claude-opus-5-5",
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 5,
        cache_write_tokens: 7,
        cost_micros: 836,
      },
      {
        provider: "fake",
        model: "claude-opus-5-5",
        input_tokens: 50,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_micros: 400,
      },
    ]);
    // Every model call and tool call links to the assistant message that made it.
    const orphans = q<{ n: number }>(
      `SELECT count(*) AS n FROM model_calls mc LEFT JOIN messages m ON m.id = mc.message_id
       WHERE mc.session_id = ? AND m.role IS NOT 'assistant'`,
    );
    expect(orphans).toEqual([{ n: 0 }]);
  });

  test("stores redacted message text and tool summaries, and streams redacted summaries", async () => {
    const secret = `sk-ant-${"x".repeat(30)}`;
    writeFileSync(join(work, "env.txt"), `API_KEY=${secret}\n`);
    fake.script([
      { tools: [{ name: "read", args: { path: "env.txt" } }] },
      { text: `The key is ${secret}.` },
    ]);
    const { d, call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    const id = s.session.id;
    await call("POST", `/v1/sessions/${id}/prompt`, { text: `use ${secret}` });
    await log.waitFor(settled(id));

    const stored = JSON.stringify(
      d.db.sqlite
        .query(
          "SELECT content FROM messages WHERE session_id = ?1 UNION ALL " +
            "SELECT result_summary FROM tool_calls WHERE session_id = ?1 UNION ALL " +
            "SELECT goal FROM tasks WHERE session_id = ?1",
        )
        .all(id),
    );
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain(secret);
    const [toolEnd] = log.ofType("agent.tool.end");
    expect(toolEnd?.summary).toContain("[redacted]");
    expect(toolEnd?.summary).not.toContain(secret);
  });

  test("a finished run adds its time to the session, so stats show active and wall time", async () => {
    fake.route(async () => {
      await Bun.sleep(30);
      return { text: "done" };
    });
    const { d, call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "go" });
    await log.waitFor(settled(s.session.id));

    const row = d.db.sqlite
      .query<{ active_ms: number | null; ended_at: number | null; started_at: number }, [string]>(
        "SELECT active_ms, ended_at, started_at FROM sessions WHERE id = ?",
      )
      .get(s.session.id);
    expect(row?.active_ms ?? 0).toBeGreaterThanOrEqual(25);
    expect(row?.ended_at ?? 0).toBeGreaterThanOrEqual(row?.started_at ?? Infinity);

    const k = kpis(d.db.sqlite, { range: "24h", source: "hamness" });
    expect(k.activeSessions).toBe(1);
    expect(k.activeMs).toBeGreaterThanOrEqual(25);
    expect(k.wallMs).toBeGreaterThanOrEqual(25);
  });

  test("detach and reattach: the snapshot shows the same session and transcript", async () => {
    writeFileSync(join(work, "notes.txt"), "fig\n");
    fake.script([
      { text: "Reading.", tools: [{ name: "read", args: { path: "notes.txt" } }] },
      { text: "fig" },
    ]);
    const { call, log } = await start();
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "word?" });
    await log.waitFor(settled(s.session.id));
    log.close();

    const back = (await (
      await call("POST", "/v1/sessions", { cwd: work })
    ).json()) as SessionSnapshot;
    expect(back.session.id).toBe(s.session.id);
    expect(back.session.busy).toBe(false);
    expect(back.seq).toBeGreaterThan(0);
    expect(
      back.items.map((i) =>
        i.kind === "message" ? `${i.role}: ${i.text}` : `tool ${i.tool} ${i.status}`,
      ),
    ).toEqual(["user: word?", "assistant: Reading.", "tool read ok", "assistant: fig"]);

    const byId = (await (
      await call("GET", `/v1/sessions/${s.session.id}`)
    ).json()) as SessionSnapshot;
    expect(byId).toEqual(back);
  });

  test("a second prompt while one runs is a 409", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fake.script([{ tools: [{ name: "read", args: { path: "x" } }] }, { text: "done" }]);
    const { call, log } = await start(async () => {
      await gate;
      return { allow: true };
    });
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "one" });
    await log.waitFor((e) => e.type === "agent.tool.start");
    expect(
      (await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "two" })).status,
    ).toBe(409);
    release();
    await log.waitFor(settled(s.session.id));
  });

  test("every tool call passes the safety check first; a denial is stored and never runs", async () => {
    fake.script([
      { tools: [{ name: "write", args: { path: "out.txt", content: "x", api_key: "sk-123" } }] },
      { text: "ok" },
    ]);
    const checked: string[] = [];
    const { d, call, log } = await start(async (c) => {
      checked.push(`${c.sessionId}:${c.tool}`);
      expect(c.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
      return { allow: false, reason: "blocked in test" };
    });
    const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
    await call("POST", `/v1/sessions/${s.session.id}/prompt`, { text: "write" });
    await log.waitFor(settled(s.session.id));

    expect(checked).toEqual([`${s.session.id}:write`]);
    expect(existsSync(join(work, "out.txt"))).toBe(false);
    const [end] = log.ofType("agent.tool.end");
    expect(end).toMatchObject({ status: "denied", summary: "blocked in test" });
    const rows = d.db.sqlite
      .query<{ status: string; args_json: string }, []>("SELECT status, args_json FROM tool_calls")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("denied");
    expect(rows[0]?.args_json).not.toContain("sk-123");
  });
});
