import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../test/support/events.ts";
import { type FakeModel, type FakeReply, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import type { HamnessEvent, SessionSnapshot } from "../events/types.ts";
import type { TaskView } from "../tasks/types.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

/* Tasks end to end: a fake model calls the task tools through Pi, the real rules check the
 * re-run, and the daemon's API and events carry the result. */

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

async function start() {
  const dataDir = join(home.dir, "data");
  daemon = await startDaemon({ dataDir, port: 0, models: async () => fake, contextFiles: false });
  const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  const l = await eventLog(daemon.wsUrl, token);
  log = l;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon?.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const s = (await (await call("POST", "/v1/sessions", { cwd: work })).json()) as SessionSnapshot;
  const id = s.session.id;
  let runs = 0;
  const run = async (text: string) => {
    runs += 1;
    const n = runs;
    await call("POST", `/v1/sessions/${id}/prompt`, { text });
    await l.waitFor(
      () =>
        l.events.filter((e) => e.type === "agent.status" && e.sessionId === id && !e.busy).length >=
        n,
      5000,
    );
  };
  const sql = (daemon as RunningDaemon).db.sqlite;
  const snapshot = async () =>
    (await (await call("GET", `/v1/sessions/${id}`)).json()) as SessionSnapshot;
  return { call, id, run, log: l, sql, snapshot };
}

const tool = (name: string, args: Record<string, unknown>, usage?: FakeReply["usage"]) => ({
  tools: [{ name, args }],
  ...(usage ? { usage } : {}),
});
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

const toolEnds = (l: NonNullable<typeof log>) => l.ofType("agent.tool.end");

describe("the agent's task tools", () => {
  test("task_start, a passing prove and task_done: verified, with every model call on the task", async () => {
    fake.script([
      tool("task_start", { goal: "say hello" }, usage(100, 10)),
      tool("prove", { kind: "command", command: "echo hello" }, usage(200, 20)),
      tool("task_done", { summary: "said hello" }, usage(300, 30)),
      { text: "Done, and verified.", usage: usage(400, 40) },
    ]);
    const { run, log, sql, snapshot } = await start();
    await run("please say hello");

    expect(toolEnds(log).map((e) => e.status)).toEqual(["ok", "ok", "ok"]);
    const types = log.events.filter((e) => e.type.startsWith("task.")).map((e) => e.type);
    expect(types).toEqual(["task.start", "task.start", "task.evidence", "task.end"]);
    const evidence = log.ofType("task.evidence")[0];
    expect(evidence).toMatchObject({ kind: "command", status: "passed", evidence: 1, passed: 1 });
    const end = log.ofType("task.end")[0];
    expect(end?.task).toMatchObject({ outcome: "verified", goal: "say hello", implicit: false });

    const taskId = end?.task.id as string;
    // The evidence links to the prove call that submitted it.
    const link = sql
      .query<{ tool: string }, []>(
        "SELECT t.tool FROM evidence e JOIN tool_calls t ON t.id = e.tool_call_id",
      )
      .all();
    expect(link).toEqual([{ tool: "prove" }]);
    const calls = sql
      .query<{ task_id: string | null; cost_micros: number }, []>(
        "SELECT task_id, cost_micros FROM model_calls",
      )
      .all();
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.task_id))).toEqual(new Set([taskId]));
    const sum = calls.reduce((n, c) => n + c.cost_micros, 0);
    expect(sum).toBeGreaterThan(0);
    const snap = await snapshot();
    expect(snap.task).toMatchObject({ id: taskId, outcome: "verified", costMicros: sum });
    expect(snap.task?.tokens).toBe(110 + 220 + 330 + 440);
    // The user's message and the tool calls count toward the task too.
    const untagged = sql
      .query<{ n: number }, []>(
        `SELECT (SELECT count(*) FROM messages WHERE task_id IS NULL)
              + (SELECT count(*) FROM tool_calls WHERE task_id IS NULL) AS n`,
      )
      .get();
    expect(untagged?.n).toBe(0);
  });

  test("evidence the agent marks as passed is refused, and task_done is unverified", async () => {
    fake.script([
      tool("task_start", { goal: "pretend" }),
      tool("prove", { kind: "command", command: "cat missing.txt", status: "passed" }),
      tool("task_done", { summary: "trust me" }),
      { text: "ok" },
    ]);
    const { run, log, sql } = await start();
    await run("go");
    const ends = toolEnds(log);
    expect(ends[1]).toMatchObject({ status: "error" });
    // Pi's schema check refuses the extra field first; parseClaim would refuse it too.
    expect(ends[1]?.summary).toContain("status");
    expect(log.ofType("task.end")[0]?.task).toMatchObject({ outcome: "unverified", evidence: 0 });
    expect(sql.query("SELECT count(*) AS n FROM evidence").get()).toEqual({ n: 0 });
  });

  test("a failing command is stored as failed, with its exit code", async () => {
    fake.script([
      tool("task_start", { goal: "read a file" }),
      tool("prove", { kind: "command", command: "cat missing.txt" }),
      tool("task_done", { summary: "read it" }),
      { text: "ok" },
    ]);
    const { run, log, sql } = await start();
    await run("go");
    expect(log.ofType("task.evidence")[0]).toMatchObject({ status: "failed" });
    const row = sql
      .query<{ status: string; result_json: string }, []>(
        "SELECT status, result_json FROM evidence",
      )
      .get();
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row?.result_json ?? "{}").exitCode).not.toBe(0);
    expect(log.ofType("task.end")[0]?.task.outcome).toBe("unverified");
  });

  test("a command re-run passes the safety rules: a denied one never runs", async () => {
    fake.script([
      tool("task_start", { goal: "sneak" }),
      tool("prove", { kind: "command", command: "sudo touch owned" }),
      { text: "ok" },
    ]);
    const { run, log, sql } = await start();
    await run("go");
    expect(log.ofType("task.evidence")[0]).toMatchObject({ status: "error" });
    expect(existsSync(join(work, "owned"))).toBe(false);
    const d = sql
      .query<{ tool: string; verdict: string }, []>(
        "SELECT tool, verdict FROM decisions WHERE tool = 'bash'",
      )
      .all();
    expect(d).toEqual([{ tool: "bash", verdict: "deny" }]);
  });

  test("a command re-run the rules don't decide asks the user", async () => {
    fake.script([
      tool("task_start", { goal: "make a dir" }),
      tool("prove", { kind: "command", command: "mkdir made" }),
      { text: "ok" },
    ]);
    const { call, id, log } = await start();
    await call("POST", `/v1/sessions/${id}/prompt`, { text: "go" });
    const req = (await log.waitFor((e) => e.type === "safety.approval.request")) as Extract<
      HamnessEvent,
      { type: "safety.approval.request" }
    >;
    expect(req.approval).toMatchObject({ tool: "bash", args: { command: "mkdir made" } });
    await call("POST", `/v1/approvals/${req.approval.id}`, { decision: "allow-once" });
    await log.waitFor((e) => e.type === "task.evidence");
    expect(log.ofType("task.evidence")[0]).toMatchObject({ status: "passed" });
    expect(existsSync(join(work, "made"))).toBe(true);
  });
});

describe("the implicit task per turn", () => {
  test("a chat turn without evidence or edits is dropped", async () => {
    fake.script([{ text: "Hello!" }]);
    const { run, log, sql, snapshot } = await start();
    await run("hi");
    const start_ = log.ofType("task.start")[0];
    expect(start_?.task).toMatchObject({ implicit: true, goal: "hi" });
    expect(log.ofType("task.drop")[0]).toEqual(
      expect.objectContaining({ taskId: start_?.task.id }),
    );
    expect(sql.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect((await snapshot()).task).toBeUndefined();
  });

  test("a turn that proves something closes on its own", async () => {
    fake.script([tool("prove", { kind: "command", command: "echo ok" }), { text: "checked" }]);
    const { run, log } = await start();
    await run("is it ok?");
    expect(log.ofType("task.end")[0]?.task).toMatchObject({ implicit: true, outcome: "verified" });
  });
});

describe("the user's task commands", () => {
  test("/task opens a task the next turn counts toward; /override accepts it", async () => {
    fake.script([{ text: "working on it", usage: usage(50, 5) }]);
    const { call, id, run, sql } = await start();
    const opened = await call("POST", `/v1/sessions/${id}/task`, { goal: "ship the feature" });
    expect(opened.status).toBe(201);
    const { task } = (await opened.json()) as { task: TaskView };
    expect(task).toMatchObject({ goal: "ship the feature", outcome: "open", implicit: false });

    await run("start");
    const tagged = sql
      .query<{ task_id: string }, []>("SELECT task_id FROM model_calls")
      .all()
      .map((r) => r.task_id);
    expect(tagged).toEqual([task.id]);

    const over = await call("POST", `/v1/sessions/${id}/override`, { reason: "looks right" });
    expect(over.status).toBe(200);
    expect(((await over.json()) as { task: TaskView }).task).toMatchObject({
      id: task.id,
      outcome: "overridden",
      reason: "looks right",
    });
  });

  test("/abandon closes the open task; with none open it is a 409", async () => {
    const { call, id } = await start();
    await call("POST", `/v1/sessions/${id}/task`, { goal: "try something" });
    const first = await call("POST", `/v1/sessions/${id}/abandon`, {});
    expect(((await first.json()) as { task: TaskView }).task.outcome).toBe("abandoned");
    expect((await call("POST", `/v1/sessions/${id}/abandon`, {})).status).toBe(409);
    expect((await call("POST", `/v1/sessions/${id}/override`, {})).status).toBe(409);
  });

  test("bad requests: no goal is a 400, an unknown session a 404", async () => {
    const { call, id } = await start();
    expect((await call("POST", `/v1/sessions/${id}/task`, { goal: " " })).status).toBe(400);
    expect((await call("POST", "/v1/sessions/nope/task", { goal: "x" })).status).toBe(404);
  });
});
