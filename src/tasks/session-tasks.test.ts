import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/** A tool call on the current task, as the hub records one. */
function call(t: SessionTasks, tool: string, args: Record<string, unknown> = {}) {
  chat.addToolCall(
    { ...ids, taskId: t.attributionId() },
    { messageId: undefined, tool, argsJson: JSON.stringify(args) },
  );
}

/** An `edit` call on the current task: a file change that needs proof. */
function edited(t: SessionTasks) {
  call(t, "edit");
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

  test("task_done with an edit and no evidence is unverified", () => {
    const t = tasks();
    const task = t.start("refactor");
    chat.addToolCall(
      { ...ids, taskId: t.attributionId() },
      { messageId: undefined, tool: "edit", argsJson: "{}" },
    );
    const done = t.done("refactored");
    expect(done.outcome).toBe("unverified");
    expect(done.dropped).toBeUndefined();
    expect(row(task.id)?.outcome).toBe("unverified");
  });

  test("task_done with a bash write and no evidence is unverified", () => {
    const t = tasks();
    t.start("write a file");
    chat.addToolCall(
      { ...ids, taskId: t.attributionId() },
      {
        messageId: undefined,
        tool: "bash",
        argsJson: JSON.stringify({ command: "echo hi > out.txt" }),
      },
    );
    expect(t.done("wrote it").outcome).toBe("unverified");
  });

  test("task_done with no evidence and only read-only calls drops the task, like a chat turn", () => {
    const t = tasks();
    const task = t.start("read the docs and summarize the repo");
    modelCall(t, 500);
    for (const [tool, args] of [
      ["read", { path: "README.md" }],
      ["grep", { pattern: "x" }],
      ["ls", {}],
      ["find", { pattern: "*.md" }],
      ["bash", { command: "cat README.md | head -20" }],
    ] as const) {
      call(t, tool, args);
    }
    const done = t.done("summarized");
    expect(done.dropped).toBe(true);
    expect(row(task.id)).toBeNull();
    expect(events.at(-1)).toEqual({ type: "task.drop", taskId: task.id });
    const calls = db.sqlite
      .query<{ task_id: string | null }, []>("SELECT task_id FROM model_calls")
      .all();
    expect(calls).toEqual([{ task_id: null }]);
    expect(t.attributionId()).toBeUndefined();
    expect(t.view()).toBeUndefined();
  });

  test("an explicit task with an MCP call, or bash that writes through a program, stays unverified", () => {
    for (const [tool, args] of [
      ["mcp__fs__write_file", { path: "x.txt", content: "1" }],
      ["bash", { command: `python -c "open('x.txt','w').write('1')"` }],
      ["some_unknown_tool", {}],
    ] as const) {
      const t = tasks();
      const task = t.start("do it");
      call(t, tool, args);
      const done = t.done("done");
      expect(done.dropped).toBeUndefined();
      expect(row(task.id)?.outcome).toBe("unverified");
    }
  });

  test("a task the user opened with /task is never dropped", () => {
    const t = tasks();
    const task = t.start("user goal", "user");
    const done = t.done("nothing to do");
    expect(done.dropped).toBeUndefined();
    expect(row(task.id)?.outcome).toBe("unverified");
  });

  test("a /task that promotes the turn's implicit task is never dropped either", () => {
    const t = tasks();
    t.beginTurn("look");
    const task = t.start("user goal", "user");
    expect(t.done("x").dropped).toBeUndefined();
    expect(row(task.id)?.outcome).toBe("unverified");
  });

  test("a task with any evidence row, even one that could not run, is not dropped", async () => {
    const t = new SessionTasks({
      ...optsFor(),
      safety: async () => ({ allow: false, reason: "no" }),
    });
    const task = t.start("check it");
    const proof = await t.prove({ kind: "command", command: PASS });
    expect(proof.result.status).toBe("error");
    expect(t.done("done").dropped).toBeUndefined();
    expect(row(task.id)?.outcome).toBe("unverified");
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
    edited(t);
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
    edited(t);
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
    edited(t);
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
    edited(t);
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
    expect(events.map((e) => e.type)).toEqual([
      "task.start",
      "check.start",
      "check.end",
      "task.evidence",
      "task.end",
    ]);
    const evidenceId = (events[3] as { evidenceId: string }).evidenceId;
    // P-M3: the rail shows the re-run while it runs.
    expect(events[1]).toEqual({
      type: "check.start",
      taskId: task.id,
      evidenceId,
      kind: "command",
      label: PASS,
    });
    expect(events[2]).toMatchObject({ type: "check.end", evidenceId, status: "passed" });
    expect(events[3]).toMatchObject({
      type: "task.evidence",
      taskId: task.id,
      kind: "command",
      status: "passed",
    });
    expect(events[4]).toMatchObject({ type: "task.end", task: { outcome: "verified" } });
  });
});

describe("checks for a reattach", () => {
  test("the session's checks, oldest first, with how they ended; a fresh SessionTasks sees them", async () => {
    const t = tasks();
    t.start("check twice");
    await t.prove({ kind: "command", command: PASS });
    await t.prove({ kind: "command", command: FAIL });
    const checks = t.checks();
    expect(checks.map((c) => [c.kind, c.label, c.status])).toEqual([
      ["command", PASS, "passed"],
      ["command", FAIL, "failed"],
    ]);
    for (const c of checks) {
      expect(c.id).toBeString();
      expect(c.endedAt).toBeGreaterThanOrEqual(c.startedAt);
      expect(c.summary).toBeString();
    }
    expect(new SessionTasks(optsFor()).checks()).toEqual(checks);
    expect(t.checks(1).map((c) => c.label)).toEqual([FAIL]);
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

describe("a re-run may cd only inside the session folder (V-M3)", () => {
  test("cd into a folder inside runs; cd out of it, home, - or through a link out is refused", async () => {
    mkdirSync(join(home.dir, "web"));
    const outside = tempHome();
    symlinkSync(outside.dir, join(home.dir, "out"));
    const t = tasks();
    t.start("check");
    expect((await t.prove({ kind: "command", command: `cd web && ${PASS}` })).result.status).toBe(
      "passed",
    );
    for (const cd of [
      "cd /tmp",
      "cd ..",
      "cd web/../..",
      "cd",
      "cd ~",
      "cd -",
      "cd out",
      "pushd /",
    ]) {
      await expect(t.prove({ kind: "command", command: `${cd} && ${PASS}` })).rejects.toThrow(
        "the session folder",
      );
    }
    await expect(
      t.prove({ kind: "command", command: `sh -c 'cd .. && ${PASS.replaceAll("'", '"')}'` }),
    ).rejects.toThrow("outside the session folder");
    outside.cleanup();
  });
});

describe("a check whose config the agent edited is weak (V-H1)", () => {
  test("editing package.json then passing a command does not verify alone", async () => {
    const t = tasks();
    t.start("make tests pass");
    fileTool(t, "edit", "package.json");
    await tick();
    const r = await t.prove({ kind: "command", command: PASS });
    expect(r.result.status).toBe("passed");
    expect(r.result.details.weakReason).toContain("package.json");
    expect(t.gate().verified).toBe(false);
    expect(t.gate().reason).toContain("weak");
    expect(t.done("done").outcome).toBe("unverified");
  });
});

/** A bash tool call on the current task, finished with `status`. */
function bashTool(t: SessionTasks, command: string, status: "ok" | "denied" = "ok") {
  const id = chat.addToolCall(
    { ...ids, taskId: t.attributionId() },
    { messageId: undefined, tool: "bash", argsJson: JSON.stringify({ command }) },
  );
  chat.finishToolCall(id, { status, summary: status });
  return id;
}

describe("bash that writes files counts as an edit (ADR 0019, issue #16)", () => {
  test("a heredoc into a file after the passing check: unverified, until it passes again", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    await tick();
    bashTool(t, "cat > calc.ts <<'EOF'\nexport const add = (a, b) => a + b;\nEOF");
    await tick();
    expect(t.gate().verified).toBe(false);
    expect(t.gate().reason).toContain("changed after");
    await t.prove({ kind: "command", command: PASS });
    expect(t.done("fixed").outcome).toBe("verified");
  });

  test("bash that only runs things, or was denied, changes nothing", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    await tick();
    bashTool(t, "bun test 2>&1");
    bashTool(t, "echo x > a.ts", "denied");
    await tick();
    expect(t.done("fixed").outcome).toBe("verified");
  });

  test("bash that writes only outside the session folder changes nothing", async () => {
    const t = tasks();
    t.start("fix");
    await t.prove({ kind: "command", command: PASS });
    await tick();
    bashTool(t, "bun test > /tmp/out.txt 2>&1");
    bashTool(t, `bun test | tee ${join(tmpdir(), "hamness-log.txt")}`);
    await tick();
    expect(t.done("fixed").outcome).toBe("verified");

    t.beginTurn("what does the test output say?");
    const id = t.attributionId() as string;
    bashTool(t, "bun test 2>&1 | tee /tmp/log.txt");
    t.endTurn();
    expect(row(id)).toBeNull();
  });

  test("a call a crash left running is closed on resume, so it can't block verification", async () => {
    const first = tasks();
    const task = first.start("fix");
    const id = chat.addToolCall(
      { ...ids, taskId: first.attributionId() },
      {
        messageId: undefined,
        tool: "bash",
        argsJson: JSON.stringify({ command: "echo x > a.ts" }),
      },
    );
    const resumed = tasks();
    const r = db.sqlite
      .query<{ status: string; ended_at: number | null }, [string]>(
        "SELECT status, ended_at FROM tool_calls WHERE id = ?",
      )
      .get(id);
    expect(r?.status).toBe("error");
    expect(r?.ended_at).not.toBeNull();
    await tick();
    await resumed.prove({ kind: "command", command: PASS });
    expect(resumed.done("fixed").outcome).toBe("verified");
    expect(resumed.view()?.id).toBe(task.id);
  });

  test("writing package.json through bash makes the check weak", async () => {
    const t = tasks();
    t.start("make tests pass");
    bashTool(t, 'echo \'{"scripts":{"test":"exit 0"}}\' > package.json');
    await tick();
    const r = await t.prove({ kind: "command", command: PASS });
    expect(r.result.details.weakReason).toContain("package.json");
    expect(t.done("done").outcome).toBe("unverified");
  });

  test("a turn that wrote a file through bash without proof closes unverified", () => {
    const t = tasks();
    t.beginTurn("write it");
    const id = t.attributionId() as string;
    bashTool(t, "printf x | tee out.txt");
    t.endTurn();
    expect(row(id)?.outcome).toBe("unverified");
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

describe("tasks link to their branch, commit and PR (P-L4)", () => {
  test("the branch is recorded at task start; passing CI fills the PR and commit", async () => {
    const sha = "b".repeat(40);
    const t = new SessionTasks({
      ...optsFor(),
      branchOf: () => "feature/x",
      gh: async (args) => {
        const a = args.join(" ");
        if (a.startsWith("repo view")) return ok(JSON.stringify({ nameWithOwner: "acme/app" }));
        if (a.startsWith("pr view"))
          return ok(
            JSON.stringify({
              headRefName: "feature/x",
              headRefOid: sha,
              url: "https://github.com/acme/app/pull/9",
            }),
          );
        if (a.startsWith("pr checks"))
          return ok(JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]));
        return { exitCode: 1, stdout: "", stderr: "unexpected" };
      },
      git: async (args) => (args[0] === "rev-parse" ? ok("feature/x\n") : ok("")),
    });
    const task = t.start("ship it");
    expect(task.branch).toBe("feature/x");
    const r = await t.prove({ kind: "ci", pr: "9" });
    expect(r.result.status).toBe("passed");
    expect(t.view()).toMatchObject({
      branch: "feature/x",
      prUrl: "https://github.com/acme/app/pull/9",
      commitSha: sha,
    });
  });

  test("outside a git repo there is no branch", () => {
    const t = new SessionTasks({ ...optsFor(), branchOf: () => undefined });
    expect(t.start("x").branch).toBeUndefined();
  });
});

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
