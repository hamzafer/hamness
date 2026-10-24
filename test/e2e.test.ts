import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliIo } from "../src/cli/io.ts";
import { runCli } from "../src/cli/run.ts";
import { dataPaths } from "../src/config/paths.ts";
import { type RunningDaemon, startDaemon } from "../src/daemon/daemon.ts";
import type { HamnessEvent, SessionSnapshot } from "../src/events/types.ts";
import type { DecisionRow } from "../src/safety/decisions.ts";
import type { StatsReport } from "../src/stats/index.ts";
import type { TaskListRow } from "../src/stats/rows.ts";
import { eventLog } from "./support/events.ts";
import { type FakeModel, fakeModel } from "./support/fake-model.ts";
import { tempHome } from "./support/temp-home.ts";

/*
 * One workday in miniature, end to end, with a scripted model and no network:
 *
 *  1. A daemon starts in a fresh data dir; a session opens in a fresh git repo.
 *  2. Turn one: the agent opens a task, writes a file (the rules allow writes in the repo),
 *     proves it with the repo's own tests (`bun test`, on the proof command list, so hamness
 *     re-runs it without asking), and closes the task: verified.
 *  3. Turn two: the agent runs a bash command no rule allows. Auto mode with no judge key
 *     asks the user, who answers through the API; the command then runs.
 *  4. `hamness stats --json` and the dashboard's /v1/tasks show the verified task and its
 *     cost; `hamness audit` shows every decision and who made it.
 *
 * The real safety rules, task checkers, database and CLI run; only the model is fake.
 */

let home: ReturnType<typeof tempHome>;
let dataDir: string;
let repo: string;
let fake: FakeModel;
let daemon: RunningDaemon;
let log: Awaited<ReturnType<typeof eventLog>>;
let token: string;
let sessionId: string;

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Sends a prompt; resolves when the agent goes idle again. */
async function turn(text: string, nth: number): Promise<void> {
  const res = await call("POST", `/v1/sessions/${sessionId}/prompt`, { text });
  expect(res.status).toBe(202);
  await log.waitFor(
    () =>
      log.events.filter((e) => e.type === "agent.status" && e.sessionId === sessionId && !e.busy)
        .length >= nth,
    10_000,
  );
}

/** Runs a CLI command in-process against the same data dir; returns what it printed. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const code = await runCli(argv, { HAMNESS_HOME: dataDir }, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeAll(async () => {
  home = tempHome();
  dataDir = join(home.dir, "data");
  repo = join(home.dir, "repo");
  mkdirSync(repo);
  const git = Bun.spawnSync(["git", "init", "-q", repo]);
  expect(git.exitCode).toBe(0);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  // The repo's test, which the agent's work has to make pass.
  writeFileSync(
    join(repo, "greeting.test.ts"),
    `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the greeting greets", () => {
  expect(readFileSync(new URL("./greeting.txt", import.meta.url), "utf8")).toContain("hello");
});
`,
  );

  fake = await fakeModel(home.dir);
  daemon = await startDaemon({ dataDir, port: 0, models: async () => fake, contextFiles: false });
  token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
  log = await eventLog(daemon.wsUrl, token);
  const snap = (await (
    await call("POST", "/v1/sessions", { cwd: repo })
  ).json()) as SessionSnapshot;
  sessionId = snap.session.id;
  expect(snap.session.mode).toBe("auto");
});

afterAll(async () => {
  log?.close();
  await daemon?.stop();
  home?.cleanup();
});

describe("a day with hamness", () => {
  test("a task: write a file, prove it with a re-run command, and it is verified", async () => {
    fake.script([
      { tools: [{ name: "task_start", args: { goal: "add a greeting" } }], usage: usage(1000, 50) },
      {
        tools: [{ name: "write", args: { path: "greeting.txt", content: "hello, world\n" } }],
        usage: usage(1200, 80),
      },
      {
        tools: [{ name: "prove", args: { kind: "command", command: "bun test" } }],
        usage: usage(1400, 40),
      },
      {
        tools: [{ name: "task_done", args: { summary: "greeting added" } }],
        usage: usage(1500, 30),
      },
      { text: "Added greeting.txt; the check passed.", usage: usage(1600, 20) },
    ]);
    await turn("add a greeting file", 1);

    expect(readFileSync(join(repo, "greeting.txt"), "utf8")).toBe("hello, world\n");
    const evidence = log.ofType("task.evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ kind: "command", status: "passed" });
    const end = log.ofType("task.end")[0];
    expect(end?.task).toMatchObject({ goal: "add a greeting", outcome: "verified" });
    expect(end?.task.costMicros).toBeGreaterThan(0);
  });

  test("a bash call no rule decides asks; the user allows it through the API", async () => {
    fake.script([
      { tools: [{ name: "bash", args: { command: "touch built.flag" } }], usage: usage(800, 20) },
      { text: "Built.", usage: usage(900, 10) },
    ]);
    const prompt = call("POST", `/v1/sessions/${sessionId}/prompt`, { text: "build it" });
    expect((await prompt).status).toBe(202);

    const ask = (await log.waitFor((e) => e.type === "safety.approval.request", 10_000)) as Extract<
      HamnessEvent,
      { type: "safety.approval.request" }
    >;
    expect(ask.approval).toMatchObject({ tool: "bash", args: { command: "touch built.flag" } });
    expect(existsSync(join(repo, "built.flag"))).toBe(false);
    const answer = await call("POST", `/v1/approvals/${ask.approval.id}`, {
      decision: "allow-once",
    });
    expect(answer.status).toBe(200);

    await log.waitFor(
      () =>
        log.events.filter((e) => e.type === "agent.status" && e.sessionId === sessionId && !e.busy)
          .length >= 2,
      10_000,
    );
    expect(existsSync(join(repo, "built.flag"))).toBe(true);
    expect(log.ofType("safety.approval.resolved")[0]).toMatchObject({
      decision: "allow",
      by: "user",
    });
  });

  test("`hamness stats --json` counts the verified task and what it cost", async () => {
    const r = await cli("stats", "--json", "--range", "24h", "--source", "hamness");
    expect(r.code).toBe(0);
    const [report] = (JSON.parse(r.out) as { reports: StatsReport[] }).reports;
    expect(report?.kpis.sessions).toBe(1);
    expect(report?.kpis.tasks.verified).toBe(1);
    expect(report?.kpis.verifiedRate).toBe(1);
    expect(report?.kpis.modelCalls).toBe(7);
    // The task's $0.0312, plus turn two's 1,700 input and 30 output tokens ($0.0074).
    expect(report?.kpis.costMicros).toBe(31_200 + 7_400);
    // All spend over the one verified task, so turn two's cost counts against it.
    expect(report?.kpis.costPerVerifiedTaskMicros).toBe(31_200 + 7_400);
  });

  test("the dashboard's /v1/tasks lists the task as verified, with its cost and evidence", async () => {
    const res = await call("GET", "/v1/tasks?range=24h");
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: TaskListRow[] };
    const task = rows.find((t) => t.goal === "add a greeting");
    expect(task).toMatchObject({
      outcome: "verified",
      implicit: false,
      summary: "greeting added",
      evidence: { checked: 1, passed: 1, pending: 0 },
    });
    // Five model calls ran inside the task: 6,700 input tokens at Opus 5.5's $4/MTok and
    // 220 output tokens at $20/MTok come to $0.0312.
    expect(task?.tokens).toBe(6700 + 220);
    expect(task?.costMicros).toBe(31_200);
  });

  test("`hamness audit` shows each decision: the rules allowed the write, the proof list the re-run, the user the bash", async () => {
    const r = await cli("audit", "--json");
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as DecisionRow[];
    const find = (tool: string, source: string) =>
      rows.find((d) => d.tool === tool && d.source === source);
    expect(find("write", "rule")).toMatchObject({ verdict: "allow" });
    expect(
      rows.some(
        (d) =>
          d.tool === "prove_command" &&
          d.args.command === "bun test" &&
          d.source === "rule" &&
          d.verdict === "allow",
      ),
    ).toBe(true);
    expect(find("bash", "user")).toMatchObject({ verdict: "allow" });
    expect(find("bash", "user")?.args.command).toBe("touch built.flag");

    const text = await cli("audit");
    expect(text.out).toContain("touch built.flag");
    expect(text.out).toMatch(/bash +allow +user/);
  });
});
