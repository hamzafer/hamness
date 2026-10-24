import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import type { Judge, JudgeRequest } from "../safety/index.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let dataDir: string;
let fake: FakeModel;
let daemon: RunningDaemon | undefined;
let log: Awaited<ReturnType<typeof eventLog>> | undefined;

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  dataDir = join(home.dir, "data");
  mkdirSync(work);
  mkdirSync(dataDir);
  fake = await fakeModel(home.dir);
});
afterEach(async () => {
  log?.close();
  log = undefined;
  await daemon?.stop();
  daemon = undefined;
  home.cleanup();
});

function userConfig(safety: Record<string, unknown>) {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ safety }));
}

async function start(judge?: Judge, cwd = work) {
  daemon = await startDaemon({
    dataDir,
    port: 0,
    models: async () => fake,
    contextFiles: false,
    ...(judge ? { judge } : {}),
  });
  const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const s = (await (await call("POST", "/v1/sessions", { cwd })).json()) as SessionSnapshot;
  const prompt = (text: string) => call("POST", `/v1/sessions/${s.session.id}/prompt`, { text });
  const settled = () =>
    (log as NonNullable<typeof log>).waitFor(
      (e) => e.type === "agent.status" && e.sessionId === s.session.id && !e.busy,
    );
  const approval = async (n = 1) => {
    const l = log as NonNullable<typeof log>;
    await l.waitFor(() => l.ofType("safety.approval.request").length >= n);
    return l.ofType("safety.approval.request")[n - 1] as Extract<
      HamnessEvent,
      { type: "safety.approval.request" }
    >;
  };
  const answer = (id: string, decision: string) =>
    call("POST", `/v1/approvals/${id}`, { decision });
  const decisions = () =>
    (daemon as RunningDaemon).db.sqlite
      .query<
        {
          tool: string;
          verdict: string;
          source: string;
          rule: string | null;
          reason: string;
          args_json: string;
          latency_ms: number;
          mode: string | null;
        },
        []
      >(
        "SELECT tool, verdict, source, rule, reason, args_json, latency_ms, mode FROM decisions ORDER BY rowid",
      )
      .all();
  return { d: daemon, log, call, s, prompt, settled, approval, answer, decisions };
}

const bashCall = (command: string) => ({ tools: [{ name: "bash", args: { command } }] });

describe("safety in the daemon", () => {
  test("a rule allow runs at once and is stored with its rule", async () => {
    writeFileSync(join(work, "a.txt"), "hi\n");
    fake.script([{ tools: [{ name: "read", args: { path: "a.txt" } }] }, { text: "ok" }]);
    const { prompt, settled, decisions, log } = await start();
    await prompt("read it");
    await settled();
    expect(log.ofType("safety.approval.request")).toHaveLength(0);
    const [d] = decisions();
    expect(d).toMatchObject({ tool: "read", verdict: "allow", source: "rule", mode: "auto" });
    expect(d?.rule).toContain("default");
    expect(d?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("a rule deny never runs and never asks", async () => {
    fake.script([bashCall("sudo touch owned"), { text: "ok" }]);
    const { prompt, settled, decisions, log } = await start();
    await prompt("go");
    await settled();
    expect(log.ofType("safety.approval.request")).toHaveLength(0);
    expect(log.ofType("agent.tool.end")[0]).toMatchObject({ status: "denied" });
    expect(log.ofType("agent.tool.end")[0]?.summary).toContain("sudo");
    expect(decisions()).toMatchObject([{ tool: "bash", verdict: "deny", source: "rule" }]);
    expect(existsSync(join(work, "owned"))).toBe(false);
  });

  test("an undecided call waits for the user; allow once runs it", async () => {
    fake.script([bashCall("mkdir made"), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions, log } = await start();
    await prompt("go");
    const req = await approval();
    expect(req.approval).toMatchObject({ tool: "bash", args: { command: "mkdir made" } });
    expect(req.approval.suggestions).toEqual([{ tool: "bash", pattern: "mkdir made *" }]);
    await Bun.sleep(50);
    expect(existsSync(join(work, "made"))).toBe(false);

    expect((await answer(req.approval.id, "allow-once")).status).toBe(200);
    await settled();
    expect(existsSync(join(work, "made"))).toBe(true);
    expect(log.ofType("safety.approval.resolved")[0]).toMatchObject({
      approvalId: req.approval.id,
      decision: "allow",
      by: "user",
    });
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual(["ask/mode", "allow/user"]);
    // An answered approval can't be answered again.
    expect((await answer(req.approval.id, "deny")).status).toBe(404);
  });

  test("deny: the call never runs and the reason is stored", async () => {
    fake.script([bashCall("mkdir nope"), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions, log } = await start();
    await prompt("go");
    const req = await approval();
    await answer(req.approval.id, "deny");
    await settled();
    expect(existsSync(join(work, "nope"))).toBe(false);
    expect(log.ofType("agent.tool.end")[0]).toMatchObject({ status: "denied" });
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual(["ask/mode", "deny/user"]);
  });

  test("allow always saves the pattern to the project config; the next match runs without asking", async () => {
    fake.script([bashCall("mkdir -p one"), bashCall("mkdir -p two"), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions, log } = await start();
    await prompt("go");
    const req = await approval();
    expect(req.approval.suggestions).toEqual([{ tool: "bash", pattern: "mkdir *" }]);
    await answer(req.approval.id, "allow-always");
    await settled();
    expect(existsSync(join(work, "one"))).toBe(true);
    expect(existsSync(join(work, "two"))).toBe(true);
    expect(log.ofType("safety.approval.request")).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(work, ".hamness", "config.json"), "utf8"));
    expect(saved).toEqual({ safety: { permission: { bash: { "mkdir *": "allow" } } } });
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual([
      "ask/mode",
      "allow/user",
      "allow/rule",
    ]);
    expect(decisions()[2]?.rule).toContain("project");
  });

  test("an explicit ask rule offers no 'always'", async () => {
    mkdirSync(join(work, "build"));
    fake.script([bashCall("rm -rf build"), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions } = await start();
    await prompt("go");
    const req = await approval();
    expect(req.approval.suggestions).toEqual([]);
    expect(req.approval.reason).toContain("rm -rf build");
    await answer(req.approval.id, "deny");
    await settled();
    expect(existsSync(join(work, "build"))).toBe(true);
    expect(decisions()[0]).toMatchObject({ verdict: "ask", source: "rule" });
  });

  test("with no answer, the approval times out into a deny", async () => {
    userConfig({ approvalTimeoutSec: 0.2 });
    fake.script([bashCall("mkdir late"), { text: "ok" }]);
    const { prompt, settled, approval, log, decisions } = await start();
    await prompt("go");
    await approval();
    await settled();
    expect(existsSync(join(work, "late"))).toBe(false);
    expect(log.ofType("safety.approval.resolved")[0]).toMatchObject({
      decision: "deny",
      by: "timeout",
    });
    expect(decisions()[1]).toMatchObject({ verdict: "deny", source: "mode" });
    expect(decisions()[1]?.reason).toContain("no answer");
  });

  test("a pending approval is in the snapshot, so a client that attaches later can answer it", async () => {
    fake.script([bashCall("mkdir later"), { text: "ok" }]);
    const { prompt, settled, approval, answer, call, s } = await start();
    await prompt("go");
    const req = await approval();
    const snap = (await (
      await call("GET", `/v1/sessions/${s.session.id}`)
    ).json()) as SessionSnapshot;
    expect(snap.approvals?.map((a) => a.id)).toEqual([req.approval.id]);
    expect(snap.session.mode).toBe("auto");
    await answer(req.approval.id, "allow-once");
    await settled();
    const after = (await (
      await call("GET", `/v1/sessions/${s.session.id}`)
    ).json()) as SessionSnapshot;
    expect(after.approvals).toEqual([]);
  });

  test("stopping the run denies a pending approval", async () => {
    fake.script([bashCall("mkdir stopped"), { text: "ok" }]);
    const { prompt, settled, approval, call, s, log } = await start();
    await prompt("go");
    await approval();
    expect((await call("POST", `/v1/sessions/${s.session.id}/abort`)).status).toBe(200);
    await settled();
    expect(existsSync(join(work, "stopped"))).toBe(false);
    expect(log.ofType("safety.approval.resolved")[0]).toMatchObject({
      decision: "deny",
      by: "abort",
    });
  });

  test("yolo mode allows everything without asking, and says so", async () => {
    userConfig({ mode: "yolo" });
    fake.script([bashCall("mkdir wild"), { text: "ok" }]);
    const { prompt, settled, decisions, log, s } = await start();
    expect(s.session.mode).toBe("yolo");
    await prompt("go");
    await settled();
    expect(existsSync(join(work, "wild"))).toBe(true);
    expect(log.ofType("safety.approval.request")).toHaveLength(0);
    expect(decisions()[0]).toMatchObject({ verdict: "allow", source: "mode", mode: "yolo" });
  });

  test("the same call three times in a row asks, even when a rule allows it", async () => {
    writeFileSync(join(work, "a.txt"), "hi\n");
    const read = { tools: [{ name: "read", args: { path: "a.txt" } }] };
    fake.script([read, read, read, { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions } = await start();
    await prompt("go");
    const req = await approval();
    expect(req.approval.reason).toContain("3 times");
    await answer(req.approval.id, "allow-once");
    await settled();
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual([
      "allow/rule",
      "allow/rule",
      "ask/rule",
      "allow/user",
    ]);
    expect(decisions()[2]?.rule).toBe("doom_loop");
  });

  test("secrets are redacted in stored decisions and in the approval event", async () => {
    const key = `sk-ant-api03-${"x7".repeat(20)}`;
    fake.script([bashCall(`ANTHROPIC_API_KEY=${key} mkdir k`), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions } = await start();
    await prompt("go");
    const req = await approval();
    expect(JSON.stringify(req)).not.toContain(key);
    await answer(req.approval.id, "deny");
    await settled();
    for (const d of decisions()) expect(d.args_json).not.toContain(key);
    const rows = daemon?.db.sqlite
      .query<{ args_json: string }, []>("SELECT args_json FROM tool_calls")
      .all();
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  test("a broken config denies with a reason that names the file", async () => {
    writeFileSync(join(dataDir, "config.json"), "{ broken");
    fake.script([bashCall("mkdir x"), { text: "ok" }]);
    const { prompt, settled, log } = await start();
    await prompt("go");
    await settled();
    expect(log.ofType("agent.tool.end")[0]?.summary).toContain("config.json");
  });

  test("answering an unknown approval is a 404, a bad decision a 400", async () => {
    fake.script([bashCall("mkdir y"), { text: "ok" }]);
    const { prompt, settled, approval, answer } = await start();
    expect((await answer("nope", "deny")).status).toBe(404);
    await prompt("go");
    const req = await approval();
    expect((await answer(req.approval.id, "maybe")).status).toBe(400);
    await answer(req.approval.id, "deny");
    await settled();
  });

  test("auto mode: the judge decides undecided calls; its allow runs without asking", async () => {
    const seen: JudgeRequest[] = [];
    fake.script([bashCall("mkdir judged"), { text: "ok" }]);
    const { prompt, settled, decisions, log } = await start(async (req) => {
      seen.push(req);
      return {
        verdict: "allow",
        reason: "creates a folder in the workspace",
        category: "fs",
        costMicros: 42,
      };
    });
    await prompt("go");
    await settled();
    expect(existsSync(join(work, "judged"))).toBe(true);
    expect(log.ofType("safety.approval.request")).toHaveLength(0);
    expect(seen[0]).toMatchObject({ tool: "bash", args: { command: "mkdir judged" }, cwd: work });
    expect(seen[0]?.evaluation.verdict).toBe("undecided");
    expect(decisions()[0]).toMatchObject({ verdict: "allow", source: "judge", mode: "auto" });
  });

  test("auto mode: a judge error or ask goes to the user; rules decide before the judge", async () => {
    let judged = 0;
    fake.script([bashCall("sudo id"), bashCall("mkdir asked"), { text: "ok" }]);
    const { prompt, settled, approval, answer, decisions } = await start(async () => {
      judged++;
      throw new Error("model down");
    });
    await prompt("go");
    const req = await approval();
    expect(req.approval.reason).toContain("model down");
    await answer(req.approval.id, "deny");
    await settled();
    expect(judged).toBe(1);
    expect(decisions().map((d) => `${d.verdict}/${d.source}`)).toEqual([
      "deny/rule",
      "ask/judge",
      "deny/user",
    ]);
  });

  test("ask mode never calls the judge", async () => {
    userConfig({ mode: "ask" });
    let judged = 0;
    fake.script([bashCall("mkdir m"), { text: "ok" }]);
    const { prompt, settled, approval, answer } = await start(async () => {
      judged++;
      return { verdict: "allow", reason: "x" };
    });
    await prompt("go");
    const req = await approval();
    await answer(req.approval.id, "deny");
    await settled();
    expect(judged).toBe(0);
  });
  test("auto mode with no key: the snapshot says so, undecided calls ask, one event", async () => {
    fake.script([bashCall("mkdir a"), bashCall("mkdir b"), { text: "ok" }]);
    const { s, prompt, settled, approval, answer, decisions, log } = await start();
    expect(s.session.judge).toBe("no-key");
    await prompt("go");
    await answer((await approval(1)).approval.id, "allow-once");
    await answer((await approval(2)).approval.id, "allow-once");
    await settled();
    const ev = log.ofType("safety.judge");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ sessionId: s.session.id, state: "no-key" });
    expect(decisions()[0]).toMatchObject({ verdict: "ask", source: "mode" });
    expect(decisions()[0]?.reason).toContain("no Anthropic API key");
  });

  test("ask mode shows no judge state", async () => {
    userConfig({ mode: "ask" });
    const { s } = await start();
    expect(s.session.judge).toBeUndefined();
  });

  test("3 judge asks in a row pause the judge for the session; POST .../judge resumes it", async () => {
    let judged = 0;
    fake.script([
      bashCall("mkdir j1"),
      bashCall("mkdir j2"),
      bashCall("mkdir j3"),
      bashCall("mkdir j4"),
      { text: "ok" },
    ]);
    const { s, call, prompt, settled, approval, answer, decisions, log } = await start(async () => {
      judged++;
      return { verdict: "ask", reason: "not sure", category: "unclear", costMicros: 3 };
    });
    expect(s.session.judge).toBe("on");
    await prompt("go");
    for (let n = 1; n <= 4; n++) await answer((await approval(n)).approval.id, "deny");
    await settled();
    expect(judged).toBe(3);
    expect(log.ofType("safety.judge")).toMatchObject([{ state: "paused" }]);
    const asks = decisions().filter((d) => d.verdict === "ask");
    expect(asks.map((d) => d.source)).toEqual(["judge", "judge", "judge", "mode"]);
    expect(asks[3]?.reason).toContain("paused");

    const res = await call("POST", `/v1/sessions/${s.session.id}/judge`, { paused: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ judge: "on" });
    // The event comes over the socket, maybe after the response.
    await log.waitFor(() => log.ofType("safety.judge").length === 2);
    expect(log.ofType("safety.judge").at(-1)).toMatchObject({ state: "on" });
    const again = await call("GET", `/v1/sessions/${s.session.id}`);
    expect(((await again.json()) as SessionSnapshot).session.judge).toBe("on");
    expect((await call("POST", "/v1/sessions/nope/judge", { paused: false })).status).toBe(404);
    expect((await call("POST", `/v1/sessions/${s.session.id}/judge`, {})).status).toBe(400);
  });

  test("judge decisions store cost and latency", async () => {
    fake.script([bashCall("mkdir costed"), { text: "ok" }]);
    const { prompt, settled, d } = await start(async () => {
      await Bun.sleep(20);
      return { verdict: "allow", reason: "fine", category: "none", costMicros: 42 };
    });
    await prompt("go");
    await settled();
    const row = d.db.sqlite
      .query<{ cost_micros: number; latency_ms: number; category: string }, []>(
        "SELECT cost_micros, latency_ms, category FROM decisions WHERE source = 'judge'",
      )
      .get();
    expect(row?.cost_micros).toBe(42);
    expect(row?.latency_ms).toBeGreaterThanOrEqual(15);
    expect(row?.category).toBe("none");
  });
});

describe("a session in / or the home folder (S-L5)", () => {
  test("the first prompt gets a notice that writes there ask", async () => {
    fake.script([{ text: "ok" }, { text: "ok" }]);
    const { prompt, settled } = await start(undefined, "/");
    await prompt("hi");
    await settled();
    const l = log as NonNullable<typeof log>;
    const notices = () => l.ofType("agent.notice").map((e) => e.message);
    expect(notices().some((m) => m.includes("home folder or /"))).toBe(true);
    const before = notices().length;
    await prompt("again");
    await l.waitFor(() => l.ofType("agent.status").filter((e) => !e.busy).length >= 2);
    expect(notices().length).toBe(before);
  });
});
