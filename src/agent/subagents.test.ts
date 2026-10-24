import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FakeContext,
  type FakeModel,
  type FakeReply,
  fakeModel,
} from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import type { AgentEvent } from "../events/types.ts";
import { createSafetyService, type SafetyCheck } from "../safety/index.ts";
import { SessionHub } from "./session-hub.ts";

let home: ReturnType<typeof tempHome>;
let work: string;
let fake: FakeModel;
let db: ReturnType<typeof openDatabase>;
let hub: SessionHub | undefined;
let events: AgentEvent[];

beforeEach(async () => {
  home = tempHome();
  work = join(home.dir, "work");
  mkdirSync(work);
  fake = await fakeModel(home.dir);
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  events = [];
});
afterEach(() => {
  hub?.stop();
  hub = undefined;
  db.close();
  home.cleanup();
});

function startHub(opts: { safety?: SafetyCheck; maxSubagents?: number } = {}) {
  hub = new SessionHub({
    db,
    dataDir: join(home.dir, "data"),
    models: async () => fake,
    contextFiles: false,
    publish: (e) => events.push(e),
    ...opts,
  });
  return hub;
}

/** The text of a context message, whatever shape its content has. */
function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("");
}

const firstUser = (ctx: FakeContext) =>
  textOf(
    ctx.messages.find((m) => m.role === "user") ?? {
      content: "",
    },
  );
const replies = (ctx: FakeContext) => ctx.messages.filter((m) => m.role === "assistant").length;
const toolResults = (ctx: FakeContext) =>
  ctx.messages.filter((m) => m.role === "toolResult").map(textOf);
const idsIn = (texts: string[]) =>
  texts.flatMap((t) => [...t.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1] as string));

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out; events: ${events.map((e) => e.type).join(", ")}`);
    }
    await Bun.sleep(5);
  }
}

const mainIdle = (sessionId: string, agentId: string) => () =>
  events.some(
    (e) =>
      e.sessionId === sessionId && e.agentId === agentId && e.type === "agent.status" && !e.busy,
  );

describe("subagents", () => {
  test("a subagent runs in the background and its final message comes back through agent_wait", async () => {
    fake.route((ctx): FakeReply => {
      if (firstUser(ctx) === "look into it") return { text: "Found the answer: 42." };
      const n = replies(ctx);
      if (n === 0) {
        return {
          tools: [{ name: "agent_start", args: { name: "scout", prompt: "look into it" } }],
        };
      }
      if (n === 1) {
        const [id] = idsIn(toolResults(ctx));
        return { tools: [{ name: "agent_wait", args: { id } }] };
      }
      return { text: `Scout says: ${toolResults(ctx).at(-1)}` };
    });
    const h = startHub();
    const snap = await h.attach(work);
    h.prompt(snap.session.id, "delegate");
    await until(mainIdle(snap.session.id, snap.session.mainAgentId as string));

    const final = h.snapshot(snap.session.id)?.items.at(-1);
    expect(final?.kind === "message" && final.text).toContain("Found the answer: 42.");
  });

  test("two subagents run in parallel and both report back", async () => {
    // Each subagent's model call waits until both are in flight: this only passes in parallel.
    const inFlight = new Set<string>();
    const bothStarted = Promise.withResolvers<void>();
    fake.route(async (ctx): Promise<FakeReply> => {
      const task = firstUser(ctx);
      if (task.startsWith("count ")) {
        inFlight.add(task);
        if (inFlight.size === 2) bothStarted.resolve();
        await bothStarted.promise;
        return { text: `${task}: done` };
      }
      const n = replies(ctx);
      if (n === 0) {
        return {
          tools: [
            { name: "agent_start", args: { name: "apples", prompt: "count apples" } },
            { name: "agent_start", args: { name: "pears", prompt: "count pears" } },
          ],
        };
      }
      if (n === 1) {
        return {
          tools: idsIn(toolResults(ctx)).map((id) => ({ name: "agent_wait", args: { id } })),
        };
      }
      return { text: toolResults(ctx).slice(-2).join("\n") };
    });
    const h = startHub();
    const snap = await h.attach(work);
    const main = snap.session.mainAgentId as string;
    h.prompt(snap.session.id, "how much fruit?");
    await until(mainIdle(snap.session.id, main));

    const final = h.snapshot(snap.session.id)?.items.at(-1);
    const text = final?.kind === "message" ? final.text : "";
    expect(text).toContain("count apples: done");
    expect(text).toContain("count pears: done");

    const started = events.filter((e) => e.type === "agent.start");
    expect(started.map((e) => e.type === "agent.start" && e.name)).toEqual(["apples", "pears"]);
    const rows = db.sqlite
      .query<{ name: string; parent_agent_id: string; model: string; status: string }, []>(
        "SELECT name, parent_agent_id, model, status FROM agents WHERE kind = 'subagent' ORDER BY name",
      )
      .all();
    expect(rows).toEqual([
      { name: "apples", parent_agent_id: main, model: "fake/claude-opus-5-5", status: "done" },
      { name: "pears", parent_agent_id: main, model: "fake/claude-opus-5-5", status: "done" },
    ]);
    // Subagent events carry their own agent id; the chat transcript stays the main agent's.
    const subIds = started.map((e) => e.agentId);
    expect(events.some((e) => e.type === "agent.message.end" && subIds.includes(e.agentId))).toBe(
      true,
    );
    const chat = h.snapshot(snap.session.id)?.items ?? [];
    expect(
      chat.filter((i) => i.kind === "message").map((i) => i.kind === "message" && i.text),
    ).toEqual(["how much fruit?", "", "", text]);
  });

  test("a subagent nobody waits for reaches the parent as a notice on its next turn", async () => {
    fake.route((ctx): FakeReply => {
      if (firstUser(ctx) === "check the logs") return { text: "The logs are clean." };
      if (firstUser(ctx) === "start it" && replies(ctx) === 0) {
        return {
          tools: [{ name: "agent_start", args: { name: "logs", prompt: "check the logs" } }],
        };
      }
      return { text: "ok" };
    });
    const h = startHub();
    const snap = await h.attach(work);
    const id = snap.session.id;
    const main = snap.session.mainAgentId as string;
    h.prompt(id, "start it");
    await until(
      () =>
        mainIdle(id, main)() &&
        events.some((e) => e.type === "agent.status" && e.agentId !== main && !e.busy),
    );

    await until(() => !h.snapshot(id)?.session.busy);
    h.prompt(id, "anything new?");
    await until(
      () => events.filter((e) => e.type === "agent.status" && e.agentId === main).length >= 4,
    );
    const sent = JSON.stringify(fake.contexts.at(-1));
    expect(sent).toContain("Subagent logs");
    expect(sent).toContain("The logs are clean.");
  });

  test("a worktree subagent edits only its own worktree, on a new branch", async () => {
    const git = (...args: string[]) =>
      Bun.spawnSync(
        ["git", "-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, "README.md"), "hello\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const outside = join(work, "escape.txt");

    fake.route((ctx): FakeReply => {
      if (firstUser(ctx) === "write the note") {
        const n = replies(ctx);
        if (n === 0)
          return {
            tools: [{ name: "write", args: { path: "note.txt", content: "from the subagent\n" } }],
          };
        if (n === 1)
          return { tools: [{ name: "write", args: { path: outside, content: "escaped\n" } }] };
        return { text: "Wrote the note." };
      }
      const n = replies(ctx);
      if (n === 0) {
        return {
          tools: [
            {
              name: "agent_start",
              args: { name: "Note Writer", prompt: "write the note", worktree: true },
            },
          ],
        };
      }
      if (n === 1)
        return { tools: [{ name: "agent_wait", args: { id: idsIn(toolResults(ctx))[0] } }] };
      return { text: toolResults(ctx).at(-1) ?? "" };
    });
    const dataDir = join(home.dir, "data");
    const h = startHub({ safety: createSafetyService({ db, dataDir, home: home.dir }).check });
    const snap = await h.attach(work);
    const main = snap.session.mainAgentId as string;
    h.prompt(snap.session.id, "delegate the note");

    // The write outside the worktree is not allowed by the rules: it asks, and we deny it.
    await until(() => events.some((e) => e.type === "safety.approval.request"));
    const ask = events.find((e) => e.type === "safety.approval.request");
    if (ask?.type !== "safety.approval.request") throw new Error("no approval");
    expect(ask.agentId).not.toBe(main);
    expect(ask.approval.agentId).toBe(ask.agentId as string);
    expect(ask.approval.args.path).toBe(outside);
    h.answerApproval(ask.approval.id, "deny");
    await until(mainIdle(snap.session.id, main));

    const row = db.sqlite
      .query<{ worktree_path: string }, []>(
        "SELECT worktree_path FROM agents WHERE kind = 'subagent'",
      )
      .get();
    const wt = row?.worktree_path as string;
    expect(wt).toContain(".hamness-worktrees");
    expect(readFileSync(join(wt, "note.txt"), "utf8")).toBe("from the subagent\n");
    expect(existsSync(join(work, "note.txt"))).toBe(false);
    expect(existsSync(outside)).toBe(false);
    const branch = Bun.spawnSync(["git", "-C", wt, "branch", "--show-current"])
      .stdout.toString()
      .trim();
    expect(branch).toMatch(/^hamness\/note-writer-[0-9a-f]{6}$/);
    const final = h.snapshot(snap.session.id)?.items.at(-1);
    expect(final?.kind === "message" && final.text).toContain(branch);
  });

  test("a subagent's cost rolls up to the parent's task and shows in the session totals", async () => {
    fake.route((ctx): FakeReply => {
      if (firstUser(ctx) === "do the costly part") {
        return { text: "done", usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } };
      }
      const n = replies(ctx);
      if (n === 0)
        return {
          tools: [{ name: "agent_start", args: { name: "costly", prompt: "do the costly part" } }],
        };
      if (n === 1)
        return { tools: [{ name: "agent_wait", args: { id: idsIn(toolResults(ctx))[0] } }] };
      return { text: "all done" };
    });
    const h = startHub();
    const snap = await h.attach(work);
    const id = snap.session.id;
    h.prompt(id, "go");
    await until(mainIdle(id, snap.session.mainAgentId as string));

    const agents = h.snapshot(id)?.agents ?? [];
    const sub = agents.find((a) => a.kind === "subagent");
    const main = agents.find((a) => a.kind === "main");
    expect(sub).toMatchObject({ name: "costly", status: "done", tokens: 1500 });
    expect(sub?.costMicros).toBeGreaterThan(0);
    // The turn's task holds the parent's calls and the subagent's, and is kept, not dropped.
    const task = db.sqlite
      .query<{ task: string; cost: number; outcome: string }, []>(
        `SELECT a.task_id AS task, t.outcome,
           (SELECT SUM(cost_micros) FROM model_calls WHERE task_id = a.task_id) AS cost
         FROM agents a JOIN tasks t ON t.id = a.task_id WHERE a.kind = 'subagent'`,
      )
      .get();
    expect(task?.outcome).toBe("unverified");
    expect(task?.cost).toBe((sub?.costMicros as number) + (main?.costMicros as number));
  });

  const statuses = () =>
    Object.fromEntries(
      db.sqlite
        .query<{ name: string; status: string }, []>(
          "SELECT name, status FROM agents WHERE kind = 'subagent'",
        )
        .all()
        .map((r) => [r.name, r.status]),
    );

  /** A parent that starts `names` (prompt = name) and then waits for each. */
  function parentStarting(names: string[], sub: (task: string) => Promise<FakeReply> | FakeReply) {
    fake.route((ctx) => {
      const task = firstUser(ctx);
      if (names.includes(task)) return sub(task);
      const n = replies(ctx);
      if (n === 0) {
        return {
          tools: names.map((name) => ({ name: "agent_start", args: { name, prompt: name } })),
        };
      }
      if (n === 1) {
        return {
          tools: idsIn(toolResults(ctx)).map((id) => ({ name: "agent_wait", args: { id } })),
        };
      }
      return { text: "finished" };
    });
  }

  test("past the concurrency cap, subagents wait in a queue", async () => {
    const gate = Promise.withResolvers<void>();
    parentStarting(["one", "two"], async (task) => {
      if (task === "one") await gate.promise;
      return { text: `${task} done` };
    });
    const h = startHub({ maxSubagents: 1 });
    const snap = await h.attach(work);
    h.prompt(snap.session.id, "go");
    await until(() => statuses().one === "running");
    await Bun.sleep(20);
    expect(statuses()).toEqual({ one: "running", two: "queued" });
    gate.resolve();
    await until(mainIdle(snap.session.id, snap.session.mainAgentId as string));
    expect(statuses()).toEqual({ one: "done", two: "done" });
  });

  test("stopping the parent stops its subagents, running and queued", async () => {
    const gate = Promise.withResolvers<void>();
    parentStarting(["slow", "later"], async () => {
      await gate.promise;
      return { text: "too late" };
    });
    const h = startHub({ maxSubagents: 1 });
    const snap = await h.attach(work);
    h.prompt(snap.session.id, "go");
    await until(() => statuses().slow === "running" && statuses().later === "queued");
    await Bun.sleep(20);
    const stopping = h.abort(snap.session.id);
    gate.resolve();
    await stopping;
    await until(mainIdle(snap.session.id, snap.session.mainAgentId as string));
    await until(() => statuses().slow !== "running");
    expect(statuses()).toEqual({ slow: "aborted", later: "aborted" });
    // The queued one never ran a model call.
    expect(fake.contexts.some((c) => firstUser(c as FakeContext) === "later")).toBe(false);
  });

  test("a subagent can run on its own model", async () => {
    fake = await fakeModel(home.dir, "claude-opus-5-5", { otherModels: ["claude-haiku-5-5"] });
    fake.route((ctx): FakeReply => {
      if (firstUser(ctx) === "be quick") return { text: "quick" };
      const n = replies(ctx);
      if (n === 0) {
        return {
          tools: [
            {
              name: "agent_start",
              args: { name: "quick", prompt: "be quick", model: "fake/claude-haiku-5-5" },
            },
            { name: "agent_start", args: { name: "bad", prompt: "x", model: "fake/nope" } },
          ],
        };
      }
      if (n === 1)
        return { tools: [{ name: "agent_wait", args: { id: idsIn(toolResults(ctx))[0] } }] };
      return { text: toolResults(ctx).join("\n") };
    });
    const h = startHub();
    const snap = await h.attach(work);
    h.prompt(snap.session.id, "go");
    await until(mainIdle(snap.session.id, snap.session.mainAgentId as string));
    const calls = db.sqlite
      .query<{ model: string }, []>(
        "SELECT mc.model FROM model_calls mc JOIN agents a ON a.id = mc.agent_id WHERE a.kind = 'subagent'",
      )
      .all();
    expect(calls).toEqual([{ model: "claude-haiku-5-5" }]);
    const final = h.snapshot(snap.session.id)?.items.at(-1);
    expect(final?.kind === "message" && final.text).toContain("unknown model fake/nope");
  });
});
