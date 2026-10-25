import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { SessionListItem, SessionStatus } from "../agent/session-hub.ts";
import type { DaemonClient, SessionCommands } from "../client/client.ts";
import type { AgentEvent, HamnessEvent, SessionSnapshot } from "../events/types.ts";
import type { TaskView } from "../tasks/types.ts";
import { App } from "./app.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

/** Where `HAMNESS_CAPTURES` asks the text captures of the screens to go (for review). */
function capture(name: string, frame: string) {
  const dir = process.env.HAMNESS_CAPTURES;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.txt`), frame);
}

const SID = "s-1";
const NEW = "s-2";
const OLD = "s-0";
const CWD = "/work/demo";

const snap = (id: string, items: SessionSnapshot["items"] = [], extra = {}): SessionSnapshot => ({
  session: { id, cwd: CWD, model: "anthropic/claude-opus-5-5", busy: false, mode: "ask" },
  seq: 3,
  items,
  ...extra,
});

const snapshot = snap(SID, [
  { kind: "message", id: "u1", role: "user", text: "find the parser bug" },
  { kind: "message", id: "a1", role: "assistant", text: "Found it in lexer.ts." },
  { kind: "message", id: "u2", role: "user", text: "now write a test for it" },
  { kind: "message", id: "a2", role: "assistant", text: "Added lexer.test.ts." },
]);

const task: TaskView = {
  id: "t1",
  goal: "fix the parser",
  implicit: false,
  outcome: "open",
  evidence: 2,
  passed: 1,
  costMicros: 120_000,
  tokens: 40_000,
  startedAt: 0,
  durationMs: 0,
};

const HOUR = 3_600_000;
const SESSIONS: SessionListItem[] = [
  {
    id: SID,
    startedAt: Date.now() - HOUR,
    lastActivityAt: Date.now() - 60_000,
    messageCount: 4,
    costMicros: 420_000,
    current: true,
    resumable: true,
    firstPrompt: "find the parser bug",
  },
  {
    id: OLD,
    name: "release notes",
    startedAt: Date.now() - 30 * HOUR,
    lastActivityAt: Date.now() - 26 * HOUR,
    messageCount: 12,
    costMicros: 1_250_000,
    current: false,
    resumable: true,
  },
  {
    id: "s-gone",
    startedAt: Date.now() - 100 * HOUR,
    lastActivityAt: Date.now() - 99 * HOUR,
    messageCount: 1,
    costMicros: 3_000,
    current: false,
    resumable: false,
    firstPrompt: "an old question",
  },
];

const STATUS: SessionStatus = {
  sessionId: SID,
  name: "parser work",
  cwd: CWD,
  branch: "feat/parser",
  model: "anthropic/claude-opus-5-5",
  thinkingLevel: "medium",
  busy: false,
  context: { tokens: 18_000, contextWindow: 200_000, percent: 9 },
  tokens: { input: 100_000, output: 2_000, cacheRead: 40_000, cacheWrite: 0, total: 142_000 },
  costMicros: 420_000,
  messages: { user: 2, assistant: 2, toolCalls: 5 },
  task,
  mode: "ask",
  modeSource: "config",
};

function fakeClient() {
  let listener: (e: HamnessEvent) => void = () => {};
  const calls: string[] = [];
  const prompts: string[] = [];
  const copied: string[] = [];
  let live = SID;
  let seq = 3;
  const send = (body: Record<string, unknown>, sessionId = live) =>
    listener({ sessionId, seq: ++seq, ...body } as AgentEvent);
  /** The daemon's replace: the old session's clients hear `session.replaced`. */
  const replace = (next: SessionSnapshot, reason: "new" | "resume" | "fork") => {
    const old = live;
    live = next.session.id;
    listener({
      sessionId: old,
      seq: ++seq,
      type: "session.replaced",
      newSessionId: next.session.id,
      reason,
    } as AgentEvent);
    return next;
  };
  const client: DaemonClient & SessionCommands = {
    ready: Promise.resolve(),
    attach: async () => (live === NEW ? snap(NEW) : snapshot),
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {},
    models: async () => [],
    setModel: async () => snapshot,
    answerApproval: async () => {},
    resumeJudge: async () => "on",
    task: async () => task,
    subscribe(onEvent) {
      listener = onEvent;
      return () => {};
    },
    newSession: async (id) => {
      calls.push(`new ${id}`);
      return replace(snap(NEW, [], { task }), "new");
    },
    listSessions: async (cwd) => {
      calls.push(`list ${cwd}`);
      return SESSIONS;
    },
    resume: async (id, target) => {
      calls.push(`resume ${id} ${target}`);
      return replace(
        snap(target, [
          { kind: "message", id: "o1", role: "user", text: "draft the release notes" },
          { kind: "message", id: "o2", role: "assistant", text: "Here is a draft." },
        ]),
        "resume",
      );
    },
    fork: async (id, messageId) => {
      calls.push(`fork ${id} ${messageId}`);
      const s = replace(
        snap("s-fork", [
          { kind: "message", id: "f1", role: "user", text: "find the parser bug" },
          { kind: "message", id: "f2", role: "assistant", text: "Found it in lexer.ts." },
        ]),
        "fork",
      );
      return { snapshot: s, text: "now write a test for it" };
    },
    compact: async (id, instructions) => {
      calls.push(`compact ${id} ${instructions ?? ""}`.trim());
      return { tokensBefore: 142_000, tokensAfter: 18_000, summary: "s" };
    },
    status: async () => STATUS,
    thinking: async () => ({ level: "medium", levels: ["off", "low", "medium", "high"] }),
    setThinking: async (_id, level) => {
      calls.push(`thinking ${level}`);
      send({ type: "agent.thinking", level });
      return { level, levels: ["off", "low", "medium", "high"] };
    },
    rename: async (_id, name) => {
      calls.push(`name ${name}`);
      send({ type: "session.name", name });
      return { ...snapshot, session: { ...snapshot.session, name } };
    },
    exportSession: async (_id, format, opts) => {
      calls.push(`export ${format} ${opts?.path ?? ""}`.trim());
      return opts?.path ? `${CWD}/${opts.path}` : `/data/exports/s-1.${format}`;
    },
    lastReply: async () => "Added lexer.test.ts.",
    mode: async () => ({ mode: "ask", source: "config" }),
    setMode: async (_id, mode) => {
      calls.push(`mode ${mode}`);
      send({ type: "safety.mode", mode, ...(mode === "yolo" ? { warning: "w" } : {}) });
      return { mode, source: "session" };
    },
    compat: async () => ({
      skills: [
        {
          name: "deploy",
          description: "Ship the app",
          scope: "project",
          userInvocable: true,
          modelInvocable: true,
        },
      ],
      mcpServers: [
        { name: "docs", scope: "user", status: "connected" },
        { name: "db", scope: "project", status: "failed", reason: "spawn ENOENT" },
      ],
    }),
  };
  return {
    client,
    calls,
    prompts,
    copied,
    send,
    sendRaw: (e: HamnessEvent) => listener(e),
    copy: async (text: string) => {
      copied.push(text);
    },
  };
}

async function render(fake: ReturnType<typeof fakeClient>, opts: { onExit?: () => void } = {}) {
  setup = await testRender(
    () => (
      <App
        client={fake.client}
        snapshot={snapshot}
        home="/home/user"
        animate={false}
        copy={fake.copy}
        {...(opts.onExit ? { onExit: opts.onExit } : {})}
      />
    ),
    { width: 110, height: 30 },
  );
  await setup.renderOnce();
  return setup;
}

/** Renders until `pred` holds (or 2s pass), then returns the frame. */
async function frameWhere(s: Setup, pred: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    await Bun.sleep(2);
    await s.renderOnce();
    const frame = s.captureCharFrame();
    if (pred(frame) || Date.now() > deadline) return frame;
  }
}

async function run(s: Setup, line: string) {
  await s.mockInput.typeText(line);
  // Past the menu: a space-less command runs from it, the same as a typed one.
  s.mockInput.pressEnter();
}

/** The menu's row for `/name`: the line it is on. */
const menuLine = (frame: string, name: string) =>
  frame.split("\n").find((l) => new RegExp(`│\\s+${name.replace("/", "\\/")}\\s`).test(l)) ?? "";

describe("the / menu", () => {
  test("a / opens it with every command, its argument hint and description", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await s.mockInput.typeText("/");
    const frame = await frameWhere(s, (f) => f.includes("Start fresh; an open task"));
    capture("slash-menu", frame);
    expect(menuLine(frame, "/new")).toContain("Start fresh; an open task");
    expect(menuLine(frame, "/compact")).toMatch(/\[instructions\]\s+Summarize the context/);
    // Aligned columns: the descriptions start in the same column.
    const at = (name: string, text: string) => menuLine(frame, name).indexOf(text);
    expect(at("/new", "Start")).toBe(at("/compact", "Summarize"));
    // The menu sits above the input box.
    const lines = frame.split("\n");
    const menuRow = lines.findIndex((l) => l.includes("Start fresh; an open task"));
    const inputRow = lines.findIndex((l) => l.includes("│/"));
    expect(menuRow).toBeGreaterThan(-1);
    expect(inputRow).toBeGreaterThan(menuRow);
  });

  test("typing filters it, fuzzily", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await s.mockInput.typeText("/cmp");
    const frame = await frameWhere(s, (f) => f.includes("Summarize the context"));
    capture("slash-menu-filtered", frame);
    expect(frame).not.toContain("Start fresh; an open task");
  });

  test("Up/Down move, Enter runs the highlighted command", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await s.mockInput.typeText("/co");
    await frameWhere(s, (f) => f.includes("Copy the last reply"));
    s.mockInput.pressArrow("down");
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => f.includes("Copied."));
    expect(fake.copied).toEqual(["Added lexer.test.ts."]);
    expect(fake.prompts).toEqual([]);
  });

  test("Tab completes the name; a command that needs an argument completes on Enter too", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await s.mockInput.typeText("/na");
    await frameWhere(s, (f) => f.includes("Name this session"));
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => !f.includes("Name this session"));
    await s.mockInput.typeText("parser work");
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => f.includes("Named: parser work"));
    expect(fake.calls).toEqual(["name parser work"]);

    await s.mockInput.typeText("/exp");
    await frameWhere(s, (f) => f.includes("Save the session"));
    s.mockInput.pressTab();
    await s.mockInput.typeText("jsonl");
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => f.includes("Exported to"));
    expect(fake.calls.at(-1)).toBe("export jsonl");
  });

  test("Esc closes it and keeps the text; it doesn't stop a running reply", async () => {
    const fake = fakeClient();
    let aborted = 0;
    fake.client.abort = async () => {
      aborted++;
    };
    const s = await render(fake);
    fake.send({ type: "agent.status", busy: true });
    await s.mockInput.typeText("/he");
    await frameWhere(s, (f) => f.includes("Every command and key"));
    s.mockInput.pressEscape();
    const frame = await frameWhere(s, (f) => !f.includes("Every command and key"));
    expect(frame).not.toContain("Every command and key");
    expect(frame).toContain("/he");
    expect(aborted).toBe(0);
  });

  test("an unknown command never reaches the model", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/zzz");
    await frameWhere(s, (f) => f.includes("Unknown command /zzz. Type / to see commands."));
    expect(fake.prompts).toEqual([]);
  });

  test("/help is generated from the registry, aliases included", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/help");
    const frame = await frameWhere(s, (f) => f.includes("Keys"));
    for (const t of ["/new", "(also /clear)", "/resume", "(also /sessions)", "/exit", "/mcp"]) {
      expect(frame).toContain(t);
    }
  });
});

describe("session commands", () => {
  test("/new clears the screen, says so, and the open task comes along", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await frameWhere(s, (f) => f.includes("Added lexer.test.ts."));
    await run(s, "/clear");
    const frame = await frameWhere(s, (f) => f.includes("New session."));
    expect(frame).toContain("New session. The open task came along: fix the parser");
    expect(frame).not.toContain("find the parser bug");
    expect(fake.calls).toEqual([`new ${SID}`]);
    // Events of the new session now show; the old one's don't.
    fake.send({ type: "agent.message.end", messageId: "n1", role: "assistant", text: "Fresh." });
    fake.send({ type: "agent.message.end", messageId: "x", role: "assistant", text: "OLD" }, SID);
    const after = await frameWhere(s, (f) => f.includes("Fresh."));
    expect(after).toContain("Fresh.");
    expect(after).not.toContain("OLD");
  });

  test("/compact shows progress from the events, then the sizes", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/compact keep the plan");
    await s.waitFor(() => fake.calls.length === 1);
    expect(fake.calls).toEqual([`compact ${SID} keep the plan`]);
    fake.send({ type: "agent.compaction.start", reason: "manual" });
    await frameWhere(s, (f) => f.includes("Compacting the context…"));
    fake.send({
      type: "agent.compaction.end",
      reason: "manual",
      aborted: false,
      tokensBefore: 142_000,
      tokensAfter: 18_000,
    });
    const frame = await frameWhere(s, (f) => f.includes("Compacted:"));
    expect(frame).toContain("Compacted: 142k → 18k tokens");
    expect(frame).not.toContain("Compacting the context…");
  });

  test("/resume lists this folder's sessions; Enter switches to one", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/sessions");
    const frame = await frameWhere(s, (f) => f.includes("Resume a session"));
    capture("resume-picker", frame);
    const row = (text: string) =>
      frame.split("\n").find((l) => l.trimStart().startsWith("│") && l.includes(text)) ?? "";
    expect(row("release notes")).toMatch(/release notes\s+yesterday\s+12 messages\s+\$1\.25/);
    expect(row("find the parser bug")).toContain("●");
    expect(row("an old question")).toContain("4d ago");
    // The highlight starts on the first other session.
    s.mockInput.pressEnter();
    const after = await frameWhere(s, (f) => f.includes("Resumed: release notes"));
    expect(after).toContain("draft the release notes");
    expect(after).not.toContain("now write a test for it");
    expect(fake.calls).toEqual([`list ${CWD}`, `resume ${SID} ${OLD}`]);
  });

  test("/resume of a session whose file is gone says so", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/resume");
    await frameWhere(s, (f) => f.includes("Resume a session"));
    s.mockInput.pressArrow("down");
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => f.includes("can't be resumed"));
    expect(fake.calls).toEqual([`list ${CWD}`]);
  });

  test("/fork picks an earlier prompt, forks there and puts it back in the input box", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/fork");
    const picker = await frameWhere(s, (f) => f.includes("Fork from a prompt"));
    // Newest first.
    const lines = picker.split("\n");
    expect(lines.findIndex((l) => l.includes("now write a test"))).toBeLessThan(
      lines.findIndex((l) => l.includes("│  ") && l.includes("find the parser bug")),
    );
    s.mockInput.pressEnter();
    const frame = await frameWhere(s, (f) => f.includes("Forked."));
    expect(fake.calls).toEqual([`fork ${SID} u2`]);
    expect(frame).not.toContain("Added lexer.test.ts.");
    expect(frame).toMatch(/│now write a test for it/);
  });

  test("/status shows a compact panel; Esc closes it", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/cost");
    const frame = await frameWhere(s, (f) => f.includes("Status"));
    capture("status", frame);
    for (const t of [
      "anthropic/claude-opus-5-5",
      "medium",
      "18k of 200k (9%)",
      "142k · 100k in, 2k out, 40k cache",
      "$0.420",
      "fix the parser · open · 1/2 checks",
      "feat/parser",
      "/work/demo",
    ]) {
      expect(frame).toContain(t);
    }
    s.mockInput.pressEscape();
    await frameWhere(s, (f) => !f.includes("18k of 200k"));
    expect(s.captureCharFrame()).not.toContain("18k of 200k");
  });

  test("/thinking alone is a picker; with a level it sets it", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/thinking");
    await frameWhere(s, (f) => f.includes("Thinking level"));
    s.mockInput.pressArrow("down");
    s.mockInput.pressEnter();
    await frameWhere(s, (f) => f.includes("Thinking: high"));
    await run(s, "/thinking low");
    await frameWhere(s, (f) => f.includes("Thinking: low"));
    expect(fake.calls).toEqual(["thinking high", "thinking low"]);
  });

  test("/mode yolo puts a loud banner across the top until it's changed back", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/mode yolo");
    const frame = await frameWhere(s, (f) => f.includes("YOLO MODE"));
    capture("yolo-banner", frame);
    // Across the top: the first row, wider than the chat pane.
    const top = frame.split("\n")[0] ?? "";
    expect(top).toContain("YOLO MODE");
    await run(s, "/mode ask");
    await frameWhere(s, (f) => !f.includes("YOLO MODE"));
    expect(s.captureCharFrame()).not.toContain("YOLO MODE");
    expect(fake.calls).toEqual(["mode yolo", "mode ask"]);
  });

  test("/mode with a bad value says how to use it", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/mode wild");
    await frameWhere(s, (f) => f.includes("Usage: /mode ask|auto|yolo"));
    expect(fake.calls).toEqual([]);
  });

  test("/name shows the name in the header", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/name parser work");
    const frame = await frameWhere(s, (f) => /hamness · parser work · /.test(f));
    expect(frame.split("\n")[0]).toContain("hamness · parser work · /work/demo");
  });

  test("/export says where the file went", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/export html out/s.html");
    await frameWhere(s, (f) => f.includes("Exported to /work/demo/out/s.html"));
    expect(fake.calls).toEqual(["export html out/s.html"]);
  });

  test("/skills and /mcp list what's loaded", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await run(s, "/skills");
    await frameWhere(s, (f) => f.includes("Ship the app"));
    await run(s, "/mcp");
    const frame = await frameWhere(s, (f) => f.includes("spawn ENOENT"));
    expect(frame).toContain("Skills (1):");
    expect(frame).toMatch(/docs\s+connected/);
    expect(frame).toMatch(/db\s+failed: spawn ENOENT/);
  });

  test("/exit and /quit leave", async () => {
    const fake = fakeClient();
    let left = 0;
    const s = await render(fake, { onExit: () => left++ });
    await run(s, "/quit");
    await s.waitFor(() => left === 1);
    expect(fake.prompts).toEqual([]);
  });

  test("a daemon error shows inline", async () => {
    const fake = fakeClient();
    fake.client.setMode = async () => {
      throw new Error("the session is being replaced; try again");
    };
    const s = await render(fake);
    await run(s, "/mode auto");
    await frameWhere(s, (f) => f.includes("the session is being replaced; try again"));
  });
});

describe("session.replaced", () => {
  test("when another window replaces the session, the TUI switches to the new one", async () => {
    const fake = fakeClient();
    const s = await render(fake);
    await frameWhere(s, (f) => f.includes("Added lexer.test.ts."));
    // Another client's /new: this client only hears the event.
    await fake.client.newSession(SID);
    const frame = await frameWhere(s, (f) => f.includes("A new session started"));
    expect(frame).not.toContain("Added lexer.test.ts.");
    fake.send({ type: "agent.message.end", messageId: "n1", role: "assistant", text: "Hello." });
    await frameWhere(s, (f) => f.includes("Hello."));
  });

  test("events of the new session that arrive before the switch are not lost", async () => {
    const fake = fakeClient();
    const base = fake.client.newSession;
    fake.client.newSession = async (id) => {
      const next = await base(id);
      fake.send({ type: "agent.message.end", messageId: "e1", role: "assistant", text: "Early." });
      return next;
    };
    const s = await render(fake);
    await run(s, "/new");
    await frameWhere(s, (f) => f.includes("Early."));
    expect(s.captureCharFrame()).toContain("Early.");
  });
});
