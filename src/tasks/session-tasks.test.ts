import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { ChatStore } from "../agent/store.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";
import {
  SessionTasks,
  type SessionTasksOptions,
  type TaskEventBody,
  TaskStateError,
} from "./session-tasks.ts";

/** Real checks that pass and fail: the shape test refuses `true` and `exit 1` (ADR 0019). */
const PASS = "bun -e 'process.exit(0)'";
const FAIL = "bun -e 'process.exit(1)'";

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;
let chat: ChatStore;
let ids: { sessionId: string; agentId: string };
let events: TaskEventBody[];

beforeEach(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "h.sqlite"));
  chat = new ChatStore(db);
  ids = chat.createSession(home.dir, "fake/m");
  events = [];
});
afterEach(() => {
  db.close();
  home.cleanup();
});

function optsFor(): SessionTasksOptions {
  return {
    db,
    sessionId: ids.sessionId,
    cwd: home.dir,
    emit: (e) => events.push(e),
    safety: async () => ({ allow: true }),
    gh: async () => ({ exitCode: 1, stdout: "", stderr: "no gh in tests" }),
    fetch: async () => {
      throw new Error("no network in tests");
    },
  };
}

function tasks() {
  return new SessionTasks(optsFor());
}

/** A model call counted toward the current task, as the hub records one. */
function modelCall(t: SessionTasks, costMicros: number, input = 100, output = 10) {
  const row = { ...ids, taskId: t.attributionId() };
  const messageId = chat.addMessage(row, "assistant", "x");
  chat.addModelCall(row, {
    messageId,
    provider: "fake",
    model: "m",
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
    costMicros,
  });
}

const row = (id: string) =>
  db.sqlite
    .query<{ outcome: string; implicit: number; goal: string; summary: string | null }, [string]>(
      "SELECT outcome, implicit, goal, summary FROM tasks WHERE id = ?",
    )
    .get(id);

describe("explicit tasks", () => {
  test("task_done with a passing command is verified", async () => {
    const t = tasks();
    const task = t.start("make the tests pass");
    const proof = await t.prove({ kind: "command", command: PASS });
    expect(proof.result.status).toBe("passed");
    const done = t.done("tests pass");
    expect(done.outcome).toBe("verified");
    expect(done.evidence).toBe(1);
    expect(done.passed).toBe(1);
    expect(row(task.id)).toMatchObject({ outcome: "verified", summary: "tests pass", implicit: 0 });
  });

  test("task_done without evidence is unverified", () => {
    const t = tasks();
    t.start("refactor");
    expect(t.done("refactored").outcome).toBe("unverified");
  });

  test("task_done with only failing evidence is unverified", async () => {
    const t = tasks();
    t.start("fix the build");
    const proof = await t.prove({ kind: "command", command: FAIL });
    expect(proof.result.status).toBe("failed");
    expect(t.done("fixed").outcome).toBe("unverified");
  });

  test("one passing piece among failures is enough", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: FAIL });
    await t.prove({ kind: "command", command: PASS });
    const done = t.done("fixed");
    expect(done.outcome).toBe("verified");
    expect(done).toMatchObject({ evidence: 2, passed: 1 });
  });

  test("an explicit task stays open across turns", () => {
    const t = tasks();
    const task = t.start("long job");
    t.beginTurn("keep going");
    expect(t.attributionId()).toBe(task.id);
    t.endTurn();
    expect(row(task.id)?.outcome).toBe("open");
  });

  test("a second task_start while one is open is refused", () => {
    const t = tasks();
    t.start("first");
    expect(() => t.start("second")).toThrow(TaskStateError);
  });

  test("task_done and prove need an open task", async () => {
    const t = tasks();
    expect(() => t.done("x")).toThrow(TaskStateError);
    await expect(t.prove({ kind: "command", command: PASS })).rejects.toThrow(TaskStateError);
  });
});

describe("the agent cannot set a result", () => {
  test("a claim that states its own result is refused and nothing is stored", async () => {
    const t = tasks();
    t.start("x");
    await expect(t.prove({ kind: "command", command: "false", status: "passed" })).rejects.toThrow(
      /only hamness's checker/,
    );
    const n = db.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM evidence").get();
    expect(n?.n).toBe(0);
    expect(t.done("done").outcome).toBe("unverified");
  });

  test("the stored result is what the checker found, not what the agent claimed", async () => {
    const t = tasks();
    t.start("x");
    await t.prove({ kind: "command", command: "echo all good && bun -e 'process.exit(2)'" });
    const ev = db.sqlite
      .query<{ status: string; result_json: string; claim_json: string }, []>(
        "SELECT status, result_json, claim_json FROM evidence",
      )
      .get();
    expect(ev?.status).toBe("failed");
    expect(JSON.parse(ev?.result_json ?? "{}").exitCode).toBe(2);
    expect(JSON.parse(ev?.claim_json ?? "{}")).toEqual({
      kind: "command",
      command: "echo all good && bun -e 'process.exit(2)'",
    });
  });

  test("only the proof module writes evidence results (structural)", () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (/UPDATE\s+evidence/i.test(readFileSync(path, "utf8"))) writers.push(path);
        }
      }
    };
    const src = join(import.meta.dir, "..");
    walk(src);
    expect(writers.map((p) => p.slice(src.length + 1))).toEqual(["tasks/proof.ts"]);
  });

  test("the agent's tools are task_start, prove and task_done: no override or abandon", async () => {
    const { taskTools } = await import("./tools.ts");
    const names = taskTools({
      start: () => {
        throw new Error("unused");
      },
      done: () => {
        throw new Error("unused");
      },
      prove: async () => {
        throw new Error("unused");
      },
    }).map((tool) => tool.name);
    expect(names.sort()).toEqual(["prove", "task_done", "task_start"]);
  });
});

describe("user actions", () => {
  test("/override turns an unverified task overridden, with the reason", () => {
    const t = tasks();
    const task = t.start("ship it");
    t.done("shipped");
    const over = t.override("checked by hand");
    expect(over).toMatchObject({ id: task.id, outcome: "overridden", reason: "checked by hand" });
  });

  test("/override closes an open task as overridden", () => {
    const t = tasks();
    t.start("ship it");
    expect(t.override().outcome).toBe("overridden");
  });

  test("/override of a verified task is refused", async () => {
    const t = tasks();
    t.start("x");
    await t.prove({ kind: "command", command: PASS });
    t.done("x");
    expect(() => t.override()).toThrow(TaskStateError);
  });

  test("/abandon closes the open task as abandoned", () => {
    const t = tasks();
    const task = t.start("dead end");
    const out = t.abandon("wrong approach");
    expect(out).toMatchObject({ id: task.id, outcome: "abandoned", reason: "wrong approach" });
    expect(() => t.abandon()).toThrow(TaskStateError);
  });

  test("/task opens a task the next turns count toward", () => {
    const t = tasks();
    const task = t.start("user goal");
    t.beginTurn("do it");
    expect(t.attributionId()).toBe(task.id);
  });
});

describe("the implicit task per turn", () => {
  test("a turn with no open task opens one, named after the prompt", () => {
    const t = tasks();
    t.beginTurn("what does this repo do?");
    const id = t.attributionId();
    expect(id).toBeDefined();
    expect(row(id as string)).toMatchObject({
      outcome: "open",
      implicit: 1,
      goal: "what does this repo do?",
    });
  });

  test("a turn with no evidence and no edits is dropped at turn end, its rows kept", () => {
    const t = tasks();
    t.beginTurn("hi");
    const id = t.attributionId() as string;
    modelCall(t, 500);
    t.endTurn();
    expect(row(id)).toBeNull();
    const calls = db.sqlite
      .query<{ task_id: string | null }, []>("SELECT task_id FROM model_calls")
      .all();
    expect(calls).toEqual([{ task_id: null }]);
    expect(events.at(-1)).toEqual({ type: "task.drop", taskId: id });
  });

  test("a turn that edited files without proof closes unverified", () => {
    const t = tasks();
    t.beginTurn("change it");
    chat.addToolCall(
      { ...ids, taskId: t.attributionId() },
      {
        messageId: undefined,
        tool: "edit",
        argsJson: "{}",
      },
    );
    const id = t.attributionId() as string;
    t.endTurn();
    expect(row(id)?.outcome).toBe("unverified");
  });

  test("a turn with failed evidence closes unverified, with passing evidence verified", async () => {
    const t = tasks();
    t.beginTurn("try");
    const failed = t.attributionId() as string;
    await t.prove({ kind: "command", command: FAIL });
    t.endTurn();
    expect(row(failed)?.outcome).toBe("unverified");

    t.beginTurn("again");
    const passed = t.attributionId() as string;
    await t.prove({ kind: "command", command: PASS });
    t.endTurn();
    expect(row(passed)?.outcome).toBe("verified");
  });

  test("task_start during a turn promotes the turn's task, so the turn's cost counts", () => {
    const t = tasks();
    t.beginTurn("please fix the parser");
    const id = t.attributionId() as string;
    modelCall(t, 100);
    const task = t.start("fix the parser");
    expect(task.id).toBe(id);
    expect(row(id)).toMatchObject({ implicit: 0, goal: "fix the parser" });
    t.endTurn();
    expect(row(id)?.outcome).toBe("open");
    expect(t.view()?.costMicros).toBe(100);
  });

  test("rows after a mid-turn close still count toward that task", () => {
    const t = tasks();
    t.beginTurn("go");
    const task = t.start("goal");
    t.done("done");
    modelCall(t, 7);
    expect(t.attributionId()).toBe(task.id);
    t.endTurn();
    t.beginTurn("next");
    expect(t.attributionId()).not.toBe(task.id);
  });

  test("a stale implicit task from a crash closes when the session resumes", () => {
    const first = tasks();
    first.beginTurn("interrupted");
    const id = first.attributionId() as string;
    tasks();
    expect(row(id)).toBeNull();
  });

  test("an explicit task survives a resume", () => {
    const task = tasks().start("multi-day");
    expect(tasks().view()?.id).toBe(task.id);
  });
});

describe("roll-up", () => {
  test("task cost and tokens equal the sum of its model calls", () => {
    const t = tasks();
    const task = t.start("count me");
    modelCall(t, 1200, 100, 20);
    modelCall(t, 800, 50, 5);
    // A call on another task does not count.
    const other = new ChatStore(db).createSession(home.dir, "fake/m");
    chat.addModelCall(
      { ...other },
      {
        messageId: chat.addMessage(other, "assistant", "y"),
        provider: "fake",
        model: "m",
        usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
        costMicros: 999,
      },
    );
    const done = t.done("ok");
    expect(done.id).toBe(task.id);
    expect(done.costMicros).toBe(2000);
    expect(done.tokens).toBe(175);
    expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);
    expect(done.durationMs).toBe((done.endedAt ?? 0) - done.startedAt);
  });
});

describe("events", () => {
  test("start, evidence and end, in order, with the roll-up on end", async () => {
    const t = tasks();
    const task = t.start("watch me");
    await t.prove({ kind: "command", command: PASS });
    t.done("ok");
    expect(events.map((e) => e.type)).toEqual(["task.start", "task.evidence", "task.end"]);
    expect(events[1]).toMatchObject({
      type: "task.evidence",
      taskId: task.id,
      kind: "command",
      status: "passed",
    });
    expect(events[2]).toMatchObject({ type: "task.end", task: { outcome: "verified" } });
  });
});

describe("file evidence uses the task window", () => {
  test("a file written during the task passes", async () => {
    const t = tasks();
    t.start("make a report");
    writeFileSync(join(home.dir, "report.md"), "# report");
    expect((await t.prove({ kind: "file", path: "report.md" })).result.status).toBe("passed");
  });
});

/** A write or edit tool call on the current task, finished unless `running`. */
function fileTool(t: SessionTasks, tool: "write" | "edit", path: string, running = false) {
  const id = chat.addToolCall(
    { ...ids, taskId: t.attributionId() },
    { messageId: undefined, tool, argsJson: JSON.stringify({ path, content: "x" }) },
  );
  if (!running) chat.finishToolCall(id, { status: "ok", summary: "ok" });
  return id;
}

/** Waits a tick so the next row's timestamp is later (rows are stamped in ms). */
const tick = () => Bun.sleep(3);

describe("the gate looks at the latest evidence (S-M5)", () => {
  test("files changed after the passing check: unverified, until it passes again", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    await tick();
    fileTool(t, "edit", "src/a.ts");
    await tick();
    expect(t.gate().verified).toBe(false);
    expect(t.gate().reason).toContain("changed after");
    await t.prove({ kind: "command", command: PASS });
    expect(t.done("fixed").outcome).toBe("verified");
  });

  test("an edit still running when the check started does not count as before it", async () => {
    const t = tasks();
    t.start("fix");
    fileTool(t, "write", "src/a.ts", true);
    await t.prove({ kind: "command", command: PASS });
    const done = t.done("fixed");
    expect(done.outcome).toBe("unverified");
  });

  test("a later failure wins over an earlier pass", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    await t.prove({ kind: "command", command: FAIL });
    expect(t.done("fixed").outcome).toBe("unverified");
  });

  test("a check that could not run (error) does not change the outcome", async () => {
    const t = new SessionTasks({
      ...optsFor(),
      safety: async (call) =>
        String(call.args.command).includes("exit(0)")
          ? { allow: true }
          : { allow: false, reason: "denied" },
    });
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    const blocked = await t.prove({ kind: "command", command: FAIL });
    expect(blocked.result.status).toBe("error");
    expect(t.done("fixed").outcome).toBe("verified");
  });
});

describe("file evidence the agent wrote itself is weak (S-H4)", () => {
  test("alone it does not verify; next to a passing command it is fine", async () => {
    const t = tasks();
    t.start("make a report");
    fileTool(t, "write", "report.md");
    writeFileSync(join(home.dir, "report.md"), "# report\n");
    await tick();
    const file = await t.prove({ kind: "file", path: "report.md" });
    expect(file.result.status).toBe("passed");
    expect(file.result.details.weak).toBe(true);
    expect(file.result.summary).toContain("weak");
    expect(t.gate().verified).toBe(false);
    expect(t.gate().reason).toContain("weak");
    await t.prove({ kind: "command", command: PASS });
    expect(t.done("made").outcome).toBe("verified");
  });

  test("a file a command produced is not weak", async () => {
    const t = tasks();
    t.start("screenshot");
    writeFileSync(join(home.dir, "shot.png"), "png");
    const file = await t.prove({ kind: "file", path: "shot.png" });
    expect(file.result.details.weak).toBeUndefined();
    expect(t.done("done").outcome).toBe("verified");
  });
});

describe("implicit tasks and checks that could not run (R-L3)", () => {
  test("a turn whose only evidence is an error and no edits is dropped", async () => {
    const t = new SessionTasks({
      ...optsFor(),
      safety: async () => ({ allow: false, reason: "denied" }),
    });
    t.beginTurn("try");
    const id = t.attributionId() as string;
    const r = await t.prove({ kind: "command", command: PASS });
    expect(r.result.status).toBe("error");
    t.endTurn();
    expect(row(id)).toBeNull();
    expect(db.sqlite.query("SELECT count(*) AS n FROM evidence").get()).toEqual({ n: 0 });
  });
});
