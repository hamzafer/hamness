import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appendLines,
  claudeAssistant,
  claudeSessionPath,
  claudeSubagentPath,
  claudeToolResult,
  claudeTurnDuration,
  claudeUser,
  codexFunctionCall,
  codexFunctionOutput,
  codexMessage,
  codexMeta,
  codexSessionPath,
  codexTaskComplete,
  codexTokenCount,
  codexTurnContext,
  jsonl,
  toolUse,
  writeLines,
} from "../../test/support/history.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import { importHistory } from "./index.ts";

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;
let claudeDir: string;
let codexDir: string;

beforeEach(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  claudeDir = join(home.dir, "claude");
  codexDir = join(home.dir, "codex");
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const all = <T>(sql: string) => db.sqlite.query<T, []>(sql).all();

describe("Claude Code import", () => {
  test("stores the session with its folder name, timings and model", async () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeUser(sid, "2026-03-01T10:00:00.000Z"),
      claudeAssistant(sid, "2026-03-01T10:00:05.000Z", { id: "msg_1", model: "claude-opus-5-5" }),
      claudeUser(sid, "2026-03-01T10:02:00.000Z"),
    ]);

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });

    expect(
      all("SELECT source, external_id, cwd, model, started_at, ended_at FROM sessions"),
    ).toEqual([
      {
        source: "claude-code",
        external_id: sid,
        cwd: "demo-app",
        model: "claude-opus-5-5",
        started_at: Date.parse("2026-03-01T10:00:00.000Z"),
        ended_at: Date.parse("2026-03-01T10:02:00.000Z"),
      },
    ]);
  });

  test("counts one model call per API response, even when it spans several lines", async () => {
    const sid = "22222222-2222-4222-8222-222222222222";
    const usage = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 };
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeUser(sid, "2026-03-01T10:00:00.000Z"),
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "msg_a", usage }),
      claudeAssistant(sid, "2026-03-01T10:00:02.000Z", {
        id: "msg_a",
        usage,
        content: [toolUse("toolu_1", "Bash")],
      }),
      claudeAssistant(sid, "2026-03-01T10:00:03.000Z", {
        id: "msg_b",
        usage: { input: 10, output: 20 },
      }),
    ]);

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });

    expect(
      all(
        "SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros FROM model_calls ORDER BY started_at",
      ),
    ).toEqual([
      // claude-sonnet-4-5: 1000*3 + 200*15 + 5000*0.3 + 300*3.75 = 8625 micro-dollars
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 5000,
        cache_write_tokens: 300,
        cost_micros: 8625,
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_micros: 330,
      },
    ]);
  });

  test("stores tool calls by name with their outcome and duration", async () => {
    const sid = "33333333-3333-4333-8333-333333333333";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeAssistant(sid, "2026-03-01T10:00:00.000Z", {
        id: "msg_1",
        content: [toolUse("toolu_ok", "Read"), toolUse("toolu_bad", "Bash")],
      }),
      claudeToolResult(sid, "2026-03-01T10:00:02.000Z", "toolu_ok"),
      claudeToolResult(sid, "2026-03-01T10:00:03.000Z", "toolu_bad", true),
      claudeAssistant(sid, "2026-03-01T10:00:04.000Z", {
        id: "msg_2",
        content: [toolUse("toolu_open", "Edit")],
      }),
    ]);

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });

    expect(
      all("SELECT tool, status, duration_ms, args_json FROM tool_calls ORDER BY tool"),
    ).toEqual([
      { tool: "Bash", status: "error", duration_ms: 3000, args_json: null },
      { tool: "Edit", status: "pending", duration_ms: null, args_json: null },
      { tool: "Read", status: "ok", duration_ms: 2000, args_json: null },
    ]);
  });

  test("adds active time from turn durations", async () => {
    const sid = "44444444-4444-4444-8444-444444444444";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeUser(sid, "2026-03-01T10:00:00.000Z"),
      claudeTurnDuration(sid, "2026-03-01T10:01:00.000Z", 45_000),
      claudeTurnDuration(sid, "2026-03-01T10:05:00.000Z", 15_000),
    ]);

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });

    expect(all("SELECT active_ms FROM sessions")).toEqual([{ active_ms: 60_000 }]);
  });

  test("a subagent file becomes a subagent of its session's main agent", async () => {
    const sid = "55555555-5555-4555-8555-555555555555";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeAssistant(sid, "2026-03-01T10:00:00.000Z", {
        id: "msg_main",
        model: "claude-opus-5-5",
      }),
    ]);
    const sub = writeLines(claudeSubagentPath(claudeDir, sid, "a1b2c3"), [
      claudeAssistant(sid, "2026-03-01T10:00:10.000Z", {
        id: "msg_sub",
        model: "claude-haiku-4-5",
        usage: { input: 10, output: 10 },
      }),
    ]);
    writeFileSync(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: "Explore", model: "claude-haiku-4-5", toolUseId: "toolu_x" }),
    );

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });

    const agents = all<{
      id: string;
      kind: string;
      name: string | null;
      model: string;
      parent_agent_id: string | null;
    }>("SELECT id, kind, name, model, parent_agent_id FROM agents ORDER BY kind");
    expect(agents.map(({ kind, name, model }) => ({ kind, name, model }))).toEqual([
      { kind: "main", name: null, model: "claude-opus-5-5" },
      { kind: "subagent", name: "Explore", model: "claude-haiku-4-5" },
    ]);
    expect(agents[1]?.parent_agent_id).toBe(agents[0]?.id ?? "");
    expect(all("SELECT count(*) AS n FROM sessions")).toEqual([{ n: 1 }]);
    expect(
      all(
        "SELECT a.kind, m.model FROM model_calls m JOIN agents a ON a.id = m.agent_id ORDER BY a.kind",
      ),
    ).toEqual([
      { kind: "main", model: "claude-opus-5-5" },
      { kind: "subagent", model: "claude-haiku-4-5" },
    ]);
    // The session's model is the main agent's, not the subagent's.
    expect(all("SELECT model FROM sessions")).toEqual([{ model: "claude-opus-5-5" }]);
  });

  test("stores no message text, tool arguments or full paths", async () => {
    const sid = "66666666-6666-4666-8666-666666666666";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeUser(sid, "2026-03-01T10:00:00.000Z", "hushword prompt"),
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", {
        id: "msg_1",
        content: [{ type: "text", text: "hushword answer" }, toolUse("toolu_1", "Bash")],
      }),
      claudeToolResult(sid, "2026-03-01T10:00:02.000Z", "toolu_1"),
    ]);

    await importHistory(db, { claudeDirs: [claudeDir], codexDirs: [] });
    db.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const raw = await Bun.file(join(home.dir, "hamness.sqlite")).text();

    expect(raw).toContain("demo-app"); // the file is readable and holds the import
    expect(raw).not.toContain("hushword");
    expect(raw).not.toContain("/work/demo-app");
    expect(raw).not.toContain(claudeDir);
  });
});

describe("incremental import", () => {
  const sid = "77777777-7777-4777-8777-777777777777";
  const session = () => claudeSessionPath(claudeDir, sid);
  const opts = () => ({ claudeDirs: [claudeDir], codexDirs: [] });
  const totals = () =>
    all("SELECT count(*) AS calls, sum(output_tokens) AS output FROM model_calls")[0];

  test("re-running adds nothing new and leaves unchanged files unread", async () => {
    writeLines(session(), [
      claudeUser(sid, "2026-03-01T10:00:00.000Z"),
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
      claudeTurnDuration(sid, "2026-03-01T10:00:02.000Z", 1000),
    ]);
    const first = await importHistory(db, opts());
    const second = await importHistory(db, opts());

    expect(first.added).toEqual({ sessions: 1, agents: 1, modelCalls: 1, toolCalls: 0 });
    expect(second.added).toEqual({ sessions: 0, agents: 0, modelCalls: 0, toolCalls: 0 });
    expect(second.files).toEqual({ read: 0, unchanged: 1, skipped: 0, failed: 0 });
    expect(second.lines).toBe(0);
    expect(all("SELECT active_ms FROM sessions")).toEqual([{ active_ms: 1000 }]);
  });

  test("a grown file imports only its new lines", async () => {
    writeLines(session(), [
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
      claudeTurnDuration(sid, "2026-03-01T10:00:02.000Z", 1000),
    ]);
    await importHistory(db, opts());
    appendLines(session(), [
      claudeAssistant(sid, "2026-03-01T11:00:00.000Z", { id: "m2", usage: { output: 7 } }),
      claudeTurnDuration(sid, "2026-03-01T11:00:01.000Z", 500),
    ]);

    const again = await importHistory(db, opts());

    expect(again.lines).toBe(2);
    expect(again.added.modelCalls).toBe(1);
    expect(totals()).toEqual({ calls: 2, output: 12 });
    expect(all("SELECT active_ms, ended_at FROM sessions")).toEqual([
      { active_ms: 1500, ended_at: Date.parse("2026-03-01T11:00:01.000Z") },
    ]);
  });

  test("a half-written last line waits for the next run", async () => {
    writeLines(session(), [
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
    ]);
    const tail = JSON.stringify(
      claudeAssistant(sid, "2026-03-01T10:00:02.000Z", { id: "m2", usage: { output: 7 } }),
    );
    appendFileSync(session(), tail.slice(0, 40));
    const first = await importHistory(db, opts());
    expect(first.badLines).toBe(0);
    expect(totals()).toEqual({ calls: 1, output: 5 });

    appendFileSync(session(), `${tail.slice(40)}\n`);
    await importHistory(db, opts());
    expect(totals()).toEqual({ calls: 2, output: 12 });
  });

  test("a rewritten, shorter file is read again from the start without double counting", async () => {
    writeLines(session(), [
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
      claudeTurnDuration(sid, "2026-03-01T10:00:02.000Z", 1000),
      claudeAssistant(sid, "2026-03-01T10:00:03.000Z", { id: "m2", usage: { output: 7 } }),
      claudeTurnDuration(sid, "2026-03-01T10:00:04.000Z", 1000),
    ]);
    await importHistory(db, opts());
    writeLines(session(), [
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
      claudeTurnDuration(sid, "2026-03-01T10:00:02.000Z", 1000),
    ]);

    await importHistory(db, opts());

    expect(all("SELECT active_ms FROM sessions")).toEqual([{ active_ms: 1000 }]);
    expect(totals()).toEqual({ calls: 2, output: 12 }); // rows already imported stay
  });

  test("a broken line is counted and skipped", async () => {
    mkdirSync(dirname(session()), { recursive: true });
    writeFileSync(
      session(),
      `not json\n${JSON.stringify(claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }))}\n`,
    );
    const r = await importHistory(db, opts());
    expect(r.badLines).toBe(1);
    expect(totals()).toEqual({ calls: 1, output: 5 });
  });
});

describe("Codex import", () => {
  const thread = "019a0000-0000-7000-8000-000000000001";
  const opts = () => ({ claudeDirs: [], codexDirs: [codexDir] });
  const rollout = (ts = "2026-03-04T10:00:00.000Z") => [
    codexMeta(thread, ts),
    codexTurnContext("2026-03-04T10:00:01.000Z", "gpt-5.5"),
    codexMessage("2026-03-04T10:00:01.500Z"),
    codexFunctionCall("2026-03-04T10:00:02.000Z", "call_1", "exec_command"),
    codexFunctionOutput("2026-03-04T10:00:04.000Z", "call_1"),
    codexTokenCount(
      "2026-03-04T10:00:05.000Z",
      { input: 1000, cached: 400, output: 100 },
      { input: 1000, cached: 400, output: 100 },
    ),
    // Codex repeats a token_count with an unchanged running total: the same call.
    codexTokenCount(
      "2026-03-04T10:00:05.100Z",
      { input: 1000, cached: 400, output: 100 },
      { input: 1000, cached: 400, output: 100 },
    ),
    codexTokenCount(
      "2026-03-04T10:00:09.000Z",
      { input: 2000, output: 50 },
      { input: 3000, cached: 400, output: 150 },
    ),
    codexTaskComplete("2026-03-04T10:00:10.000Z", 9000),
  ];

  test("stores the session, model calls with uncached input split out, and tools", async () => {
    writeLines(codexSessionPath(codexDir, thread), rollout());

    await importHistory(db, opts());

    expect(
      all("SELECT source, external_id, cwd, model, active_ms, started_at, ended_at FROM sessions"),
    ).toEqual([
      {
        source: "codex",
        external_id: thread,
        cwd: "codex-app",
        model: "gpt-5.5",
        active_ms: 9000,
        started_at: Date.parse("2026-03-04T10:00:00.000Z"),
        ended_at: Date.parse("2026-03-04T10:00:10.000Z"),
      },
    ]);
    expect(
      all(
        "SELECT provider, model, input_tokens, cache_read_tokens, output_tokens, cost_micros FROM model_calls ORDER BY started_at",
      ),
    ).toEqual([
      // gpt-5.5: 600*5 + 400*0.5 + 100*30 = 6200
      {
        provider: "openai",
        model: "gpt-5.5",
        input_tokens: 600,
        cache_read_tokens: 400,
        output_tokens: 100,
        cost_micros: 6200,
      },
      // 2000*5 + 50*30 = 11500
      {
        provider: "openai",
        model: "gpt-5.5",
        input_tokens: 2000,
        cache_read_tokens: 0,
        output_tokens: 50,
        cost_micros: 11500,
      },
    ]);
    expect(all("SELECT tool, status, duration_ms FROM tool_calls")).toEqual([
      { tool: "exec_command", status: "ok", duration_ms: 2000 },
    ]);
  });

  test("re-import is a no-op and appended lines continue with the last model", async () => {
    const path = writeLines(codexSessionPath(codexDir, thread), rollout());
    await importHistory(db, opts());
    expect((await importHistory(db, opts())).added.modelCalls).toBe(0);

    appendLines(path, [
      codexTokenCount(
        "2026-03-04T11:00:00.000Z",
        { input: 10, output: 10 },
        { input: 3010, cached: 400, output: 160 },
      ),
    ]);
    const again = await importHistory(db, opts());

    expect(again.lines).toBe(1);
    expect(again.added.modelCalls).toBe(1);
    expect(
      all(
        "SELECT model FROM model_calls WHERE started_at = " +
          Date.parse("2026-03-04T11:00:00.000Z"),
      ),
    ).toEqual([{ model: "gpt-5.5" }]);
  });

  test("a thread with a parent becomes a subagent in the parent's session", async () => {
    const child = "019a0000-0000-7000-8000-000000000002";
    writeLines(codexSessionPath(codexDir, thread), rollout());
    writeLines(codexSessionPath(codexDir, child), [
      codexMeta(child, "2026-03-04T10:01:00.000Z", { parent_thread_id: thread }),
      codexTurnContext("2026-03-04T10:01:01.000Z", "gpt-5.6-luna"),
      codexTokenCount(
        "2026-03-04T10:01:02.000Z",
        { input: 100, output: 10 },
        { input: 100, output: 10 },
      ),
    ]);

    await importHistory(db, opts());

    expect(all("SELECT count(*) AS n, max(model) AS model FROM sessions")).toEqual([
      { n: 1, model: "gpt-5.5" },
    ]);
    expect(
      all(
        "SELECT a.kind, a.model, count(m.id) AS calls FROM agents a LEFT JOIN model_calls m ON m.agent_id = a.id GROUP BY a.id ORDER BY a.kind",
      ),
    ).toEqual([
      { kind: "main", model: "gpt-5.5", calls: 2 },
      { kind: "subagent", model: "gpt-5.6-luna", calls: 1 },
    ]);
  });

  test("reads zstd-compressed rollouts", async () => {
    const path = `${codexSessionPath(codexDir, thread)}.zst`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Bun.zstdCompressSync(new TextEncoder().encode(jsonl(rollout()))));

    const r = await importHistory(db, opts());

    expect(r.files.read).toBe(1);
    expect(all("SELECT count(*) AS n FROM model_calls")).toEqual([{ n: 2 }]);
  });

  test("skips files from before session_meta (no token counts)", async () => {
    writeLines(codexSessionPath(codexDir, thread), [
      { id: thread, timestamp: "2025-05-01T10:00:00.000Z", instructions: "", git: {} },
      { type: "message", role: "user", content: [] },
    ]);

    const first = await importHistory(db, opts());
    const second = await importHistory(db, opts());

    expect(first.files.skipped).toBe(1);
    expect(second.files.skipped).toBe(1);
    expect(all("SELECT count(*) AS n FROM sessions")).toEqual([{ n: 0 }]);
  });
});

describe("read-only sources", () => {
  /** Every file and dir under `root` with its mode, size, mtime and content hash. */
  function snapshot(root: string) {
    const out: Record<string, string> = {};
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      const path = join(root, rel);
      const st = statSync(path);
      const hash = st.isFile()
        ? new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
        : "dir";
      out[rel] = `${st.mode}:${st.size}:${st.mtimeMs}:${hash}`;
    }
    return out;
  }

  function setModes(root: string, file: number, dir: number) {
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      const path = join(root, rel);
      chmodSync(path, statSync(path).isDirectory() ? dir : file);
    }
    chmodSync(root, dir);
  }

  test("imports from files and dirs nobody may write, and changes nothing there", async () => {
    const sid = "88888888-8888-4888-8888-888888888888";
    const thread = "019a0000-0000-7000-8000-000000000009";
    writeLines(claudeSessionPath(claudeDir, sid), [
      claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
    ]);
    const sub = writeLines(claudeSubagentPath(claudeDir, sid, "ab12"), [
      claudeAssistant(sid, "2026-03-01T10:00:02.000Z", { id: "m2", usage: { output: 5 } }),
    ]);
    writeFileSync(sub.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore" }));
    writeLines(codexSessionPath(codexDir, thread), [
      codexMeta(thread, "2026-03-04T10:00:00.000Z"),
      codexTokenCount("2026-03-04T10:00:01.000Z", { input: 1, output: 1 }, { input: 1, output: 1 }),
    ]);
    try {
      setModes(claudeDir, 0o444, 0o555);
      setModes(codexDir, 0o444, 0o555);
      const before = { claude: snapshot(claudeDir), codex: snapshot(codexDir) };
      const opts = { claudeDirs: [claudeDir], codexDirs: [codexDir] };
      const first = await importHistory(db, opts);
      await importHistory(db, opts);

      expect(first.files).toEqual({ read: 3, unchanged: 0, skipped: 0, failed: 0 });
      expect(all("SELECT count(*) AS n FROM model_calls")).toEqual([{ n: 3 }]);
      expect({ claude: snapshot(claudeDir), codex: snapshot(codexDir) }).toEqual(before);
    } finally {
      setModes(claudeDir, 0o644, 0o755);
      setModes(codexDir, 0o644, 0o755);
    }
  });
});
