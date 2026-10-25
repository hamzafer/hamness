import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { hookFixture } from "../../test/support/hooks.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { trustProject } from "../compat/hooks.ts";
import { dataPaths } from "../config/paths.ts";
import type { SessionSnapshot } from "../events/types.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let dataDir: string;
let claudeDir: string;
let fake: FakeModel;
let fx: ReturnType<typeof hookFixture>;
let daemon: RunningDaemon | undefined;
let log: Awaited<ReturnType<typeof eventLog>> | undefined;

beforeEach(async () => {
  home = tempHome();
  const root = realpathSync(home.dir);
  work = join(root, "work");
  dataDir = join(root, "data");
  claudeDir = join(root, "claude");
  mkdirSync(work);
  mkdirSync(dataDir);
  fake = await fakeModel(root);
  fx = hookFixture(root);
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
    dataDir,
    port: 0,
    models: async () => fake,
    contextFiles: false,
    claudeConfigDir: claudeDir,
  });
  const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const l = log;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
  const prompt = (text: string) => call("POST", `/v1/sessions/${s.session.id}/prompt`, { text });
  /** The n-th time the session went idle after being busy. */
  const settled = async (n = 1, timeoutMs = 5000) => {
    await l.waitFor(
      () =>
        l.ofType("agent.status").filter((e) => e.sessionId === s.session.id && !e.busy).length >= n,
      timeoutMs,
    );
  };
  const decisions = () =>
    (daemon as RunningDaemon).db.sqlite
      .query<
        { tool: string; verdict: string; source: string; rule: string | null; reason: string },
        []
      >("SELECT tool, verdict, source, rule, reason FROM decisions ORDER BY rowid")
      .all();
  return { s, prompt, settled, decisions, log: l };
}

const bashCall = (command: string) => ({ tools: [{ name: "bash", args: { command } }] });
/** Every text block the model was sent in its last call. */
const lastContext = () => JSON.stringify(fake.contexts.at(-1)?.messages ?? []);

describe("Claude Code hooks in the daemon", () => {
  test("a PreToolUse deny blocks the call and is in the audit log with source hook", async () => {
    fx.settings(claudeDir, { PreToolUse: [{ matcher: "Bash" }] });
    fx.respond({
      PreToolUse: {
        stdout: {
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not today" },
        },
      },
    });
    fake.script([bashCall("mkdir blocked"), { text: "ok" }]);
    const { prompt, settled, decisions, log, s } = await start();
    await prompt("go");
    await settled();
    expect(existsSync(join(work, "blocked"))).toBe(false);
    expect(log.ofType("agent.tool.end")[0]).toMatchObject({
      status: "denied",
      summary: "not today",
    });
    expect(decisions()).toMatchObject([
      { tool: "bash", verdict: "deny", source: "hook", reason: "not today" },
    ]);
    expect(decisions()[0]?.rule).toContain("hook.ts");
    const [call] = fx.calls();
    expect(call?.input).toMatchObject({
      session_id: s.session.id,
      cwd: work,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "mkdir blocked" },
    });
    expect(typeof call?.input.tool_use_id).toBe("string");
  });

  test("a hook allow skips the ask, but never overrides a rule deny", async () => {
    fx.settings(claudeDir, { PreToolUse: [{}] });
    fx.respond({ PreToolUse: { stdout: { hookSpecificOutput: { permissionDecision: "allow" } } } });
    fake.script([bashCall("mkdir fine"), bashCall("sudo touch owned"), { text: "ok" }]);
    const { prompt, settled, decisions, log } = await start();
    await prompt("go");
    await settled();
    expect(log.ofType("safety.approval.request")).toHaveLength(0);
    expect(existsSync(join(work, "fine"))).toBe(true);
    expect(existsSync(join(work, "owned"))).toBe(false);
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual([
      "allow/hook",
      "allow/hook",
      "deny/rule",
    ]);
  });

  test("a hook ask asks the user even when a rule allows, with the hook's reason", async () => {
    writeFileSync(join(work, "a.txt"), "hi\n");
    fx.settings(claudeDir, { PreToolUse: [{ matcher: "Read" }] });
    fx.respond({
      PreToolUse: {
        stdout: {
          hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check this" },
        },
      },
    });
    fake.script([{ tools: [{ name: "read", args: { path: "a.txt" } }] }, { text: "ok" }]);
    const { prompt, settled, decisions, log } = await start();
    await prompt("go");
    await log.waitFor((e) => e.type === "safety.approval.request");
    const [req] = log.ofType("safety.approval.request");
    expect(req?.approval).toMatchObject({ tool: "read", reason: "check this", suggestions: [] });
    await fetch(`${daemon?.url}/v1/approvals/${req?.approval.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(dataPaths(dataDir).token, "utf8").trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "allow-once" }),
    });
    await settled();
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual(["ask/hook", "allow/user"]);
  });

  test("a hook that hangs times out; the call goes on to the rules and the session settles", async () => {
    writeFileSync(join(work, "a.txt"), "hi\n");
    fx.settings(claudeDir, { PreToolUse: [{ timeout: 0.3 }] });
    fx.respond({ PreToolUse: { sleepMs: 30_000 } });
    fake.script([{ tools: [{ name: "read", args: { path: "a.txt" } }] }, { text: "ok" }]);
    const { prompt, settled, decisions } = await start();
    await prompt("go");
    await settled();
    expect(decisions()).toMatchObject([{ tool: "read", verdict: "allow", source: "rule" }]);
  });

  test("PostToolUse runs after the tool with its result; its feedback reaches the model", async () => {
    fx.settings(claudeDir, { PostToolUse: [{ matcher: "Bash" }] });
    fx.respond({ PostToolUse: { stdout: { decision: "block", reason: "formatter complained" } } });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ safety: { mode: "yolo" } }));
    fake.script([bashCall("echo hi"), { text: "ok" }]);
    const { prompt, settled } = await start();
    await prompt("go");
    await settled();
    const [call] = fx.calls();
    expect(call?.input).toMatchObject({
      hook_event_name: "PostToolUse",
      permission_mode: "bypassPermissions",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(JSON.stringify(call?.input.tool_response)).toContain('"stdout":"hi');
    expect(lastContext()).toContain("formatter complained");
  });

  test("UserPromptSubmit gets the prompt; its context reaches the model", async () => {
    fx.settings(claudeDir, { UserPromptSubmit: [{}] });
    fx.respond({ UserPromptSubmit: { stdout: "the build is red" } });
    fake.script([{ text: "ok" }]);
    const { prompt, settled } = await start();
    await prompt("what now?");
    await settled();
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "what now?",
    });
    expect(lastContext()).toContain("what now?");
    expect(lastContext()).toContain("the build is red");
  });

  test("a UserPromptSubmit block keeps the prompt from the model and tells the user why", async () => {
    fx.settings(claudeDir, { UserPromptSubmit: [{}] });
    fx.respond({
      UserPromptSubmit: { stdout: { decision: "block", reason: "no secrets please" } },
    });
    fake.script([{ text: "should not run" }]);
    const { prompt, settled, log } = await start();
    await prompt("my password is hunter2");
    await settled();
    expect(fake.calls).toBe(0);
    expect(
      log
        .ofType("agent.notice")
        .map((e) => e.message)
        .join(),
    ).toContain("no secrets please");
  });

  test("a Stop block makes the agent continue with the reason; stop_hook_active says so", async () => {
    const once = `grep -q '"stop_hook_active":false' && echo '{"decision":"block","reason":"run the tests"}' || true`;
    fx.settings(claudeDir, { Stop: [{}, { command: once }] });
    fake.script([{ text: "done" }, { text: "tests pass" }]);
    const { prompt, settled } = await start();
    await prompt("fix it");
    await settled();
    const stops = fx.calls().filter((c) => c.input.hook_event_name === "Stop");
    expect(stops.map((c) => c.input.stop_hook_active)).toEqual([false, true]);
    expect(stops[0]?.input.last_assistant_message).toBe("done");
    expect(fake.calls).toBe(2);
    expect(JSON.stringify(fake.contexts[1]?.messages)).toContain("run the tests");
  });

  test("a Stop hook that always blocks is cut off after 8 continuations", async () => {
    fx.settings(claudeDir, { Stop: [{}] });
    fx.respond({ Stop: { stdout: { decision: "block", reason: "again" } } });
    fake.script(Array.from({ length: 12 }, (_, i) => ({ text: `reply ${i}` })));
    const { prompt, settled } = await start();
    await prompt("go");
    await settled(1, 15_000);
    expect(fake.calls).toBe(9);
  }, 20_000);

  test("SessionStart runs when the session starts; its context reaches the first prompt", async () => {
    fx.settings(claudeDir, { SessionStart: [{ matcher: "startup" }] });
    fx.respond({
      SessionStart: { stdout: { hookSpecificOutput: { additionalContext: "on branch main" } } },
    });
    fake.script([{ text: "ok" }, { text: "ok again" }]);
    const { prompt, settled, s } = await start();
    await prompt("hi");
    await settled();
    expect(fx.calls()[0]?.input).toMatchObject({
      session_id: s.session.id,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "fake/claude-opus-5-5",
    });
    expect(lastContext()).toContain("on branch main");
    await prompt("again");
    await settled(2);
    // Only the first prompt carries it.
    expect(JSON.stringify(fake.contexts[1]?.messages).split("on branch main")).toHaveLength(2);
  });

  test("/new fires SessionStart with source clear, as Claude Code's /clear does", async () => {
    fx.settings(claudeDir, { SessionStart: [{ matcher: "clear" }] });
    fake.script([{ text: "ok" }]);
    const { s, log } = await start();
    const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
    const res = await fetch(`${daemon?.url}/v1/sessions/${s.session.id}/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    const next = (await res.json()) as SessionSnapshot;
    await log.waitFor(() => fx.calls().length > 0);
    expect(fx.calls()).toHaveLength(1);
    expect(fx.calls()[0]?.input).toMatchObject({
      session_id: next.session.id,
      hook_event_name: "SessionStart",
      source: "clear",
    });
  });

  test("/compact fires SessionStart with source compact; its context reaches the next prompt", async () => {
    fx.settings(claudeDir, { SessionStart: [{ matcher: "compact" }] });
    fx.respond({
      SessionStart: { stdout: { hookSpecificOutput: { additionalContext: "after compaction" } } },
    });
    const big = (tag: string) => `${tag} ${"lorem ipsum dolor ".repeat(6000)}`;
    const usage = { input: 60_000, output: 5, cacheRead: 0, cacheWrite: 0 };
    fake.script([
      { text: "r1", usage: { ...usage, input: 30_000 } },
      { text: "r2", usage },
      { text: "SUMMARY" },
      { text: "r3" },
    ]);
    const { s, prompt, settled } = await start();
    await prompt(big("first"));
    await settled();
    await prompt(big("second"));
    await settled(2);
    expect(fx.calls()).toHaveLength(0);
    const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
    const res = await fetch(`${daemon?.url}/v1/sessions/${s.session.id}/compact`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "SessionStart",
      source: "compact",
    });
    await prompt("next");
    await settled(3);
    expect(lastContext()).toContain("after compaction");
  }, 15_000);

  test("project hooks wait for trust, and the user is told", async () => {
    fx.settings(join(work, ".claude"), { UserPromptSubmit: [{}] });
    fake.script([{ text: "ok" }, { text: "ok" }]);
    const { prompt, settled, log } = await start();
    await prompt("hi");
    await settled();
    expect(fx.calls()).toHaveLength(0);
    expect(log.ofType("agent.notice")[0]?.message).toContain("hamness trust");
    trustProject(dataDir, work);
    await prompt("hi");
    await settled(2);
    expect(fx.calls()).toHaveLength(1);
  });
});
