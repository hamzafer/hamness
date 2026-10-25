import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { DaemonClient } from "../client/client.ts";
import type { AgentEvent, HamnessEvent, SessionSnapshot } from "../events/types.ts";
import type { TaskAction } from "../tasks/types.ts";
import { App } from "./app.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

const SID = "s-1";

const snapshot: SessionSnapshot = {
  session: { id: SID, cwd: "/work/demo", model: "anthropic/claude-opus-5-5", busy: false },
  seq: 7,
  items: [
    { kind: "message", id: "m1", role: "user", text: "what is the word?" },
    { kind: "message", id: "m2", role: "assistant", text: "Let me read it." },
    {
      kind: "tool",
      id: "t1",
      tool: "read",
      args: { path: "notes.txt" },
      status: "ok",
      durationMs: 12,
    },
    { kind: "message", id: "m3", role: "assistant", text: "The word is fig." },
  ],
};

function fakeClient() {
  let listener: (e: HamnessEvent) => void = () => {};
  const prompts: string[] = [];
  const resumed: string[] = [];
  const actions: TaskAction[] = [];
  const client: DaemonClient = {
    ready: Promise.resolve(),
    attach: async () => snapshot,
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {},
    models: async () => [],
    setModel: async () => snapshot,
    answerApproval: async () => {},
    resumeJudge: async (id) => {
      resumed.push(id);
      return "on";
    },
    task: async (_id, action) => {
      actions.push(action);
      if (action.kind === "abandon") throw new Error("no open task: nothing to abandon");
      return {
        id: "t1",
        goal: action.kind === "start" ? action.goal : "g",
        implicit: false,
        outcome: action.kind === "start" ? "open" : "overridden",
        evidence: 0,
        passed: 0,
        costMicros: 0,
        tokens: 0,
        startedAt: 0,
        durationMs: 0,
      };
    },
    subscribe(onEvent) {
      listener = onEvent;
      return () => {};
    },
  };
  let seq = snapshot.seq;
  const send = (body: Record<string, unknown>) =>
    listener({ sessionId: SID, seq: ++seq, ...body } as AgentEvent);
  return { client, prompts, resumed, actions, send, sendRaw: (e: HamnessEvent) => listener(e) };
}

async function render(
  client: DaemonClient,
  snap: SessionSnapshot = snapshot,
  opts: { kittyKeyboard?: boolean } = {},
) {
  setup = await testRender(() => <App client={client} snapshot={snap} />, {
    width: 100,
    height: 24,
    ...opts,
  });
  await setup.renderOnce();
  return setup;
}

/**
 * Renders until `pred` holds. Assistant Markdown lays out a few milliseconds after its content
 * changes, so this waits on the clock too, not only on render passes.
 */
async function frameWhere(s: Setup, pred: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    await Bun.sleep(2);
    await s.renderOnce();
    const frame = s.captureCharFrame();
    if (pred(frame) || Date.now() > deadline) return frame;
  }
}

describe("TUI chat layout (headless)", () => {
  test("renders the transcript, a compact tool line, the input box and the rail placeholder", async () => {
    const s = await render(fakeClient().client);
    const frame = await frameWhere(s, (f) => f.includes("The word is fig."));
    expect(frame).toContain("what is the word?");
    expect(frame).toContain("Let me read it.");
    expect(frame).toMatch(/read +notes\.txt.*12ms/);
    expect(frame).toContain("The word is fig.");
    expect(frame).toContain("Ask hamness");
    expect(frame).toContain("side rail");
    expect(frame).toContain("/work/demo");
    // The rail sits on the right of the chat.
    const line = frame.split("\n").find((l) => l.includes("The word is fig.")) ?? "";
    const railLine = frame.split("\n").find((l) => l.includes("side rail")) ?? "";
    expect(railLine.indexOf("side rail")).toBeGreaterThan(line.indexOf("The word is fig."));
  });

  test("streams a reply as deltas arrive and shows tool calls as they run", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({ type: "agent.message.start", messageId: "m4", role: "assistant" });
    fake.send({ type: "agent.message.delta", messageId: "m4", text: "Streaming " });
    fake.send({ type: "agent.message.delta", messageId: "m4", text: "works." });
    await frameWhere(s, (f) => f.includes("Streaming works."));
    fake.send({
      type: "agent.tool.start",
      toolCallId: "t2",
      tool: "bash",
      args: { command: "bun test" },
    });
    await s.waitForFrame((f) => /bash +bun test/.test(f));
    fake.send({ type: "agent.tool.end", toolCallId: "t2", status: "error", summary: "1 fail" });
    await s.waitForFrame((f) => /✗ bash +bun test +1 fail/.test(f));
  });

  test("a working line with elapsed seconds shows until the first token, then between tools", async () => {
    const fake = fakeClient();
    const clock = { t: 0 };
    setup = await testRender(
      () => <App client={fake.client} snapshot={snapshot} now={() => clock.t} />,
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    const s = setup;
    expect(s.captureCharFrame()).not.toContain("Thinking…");
    fake.send({ type: "agent.message.start", messageId: "u2", role: "user" });
    fake.send({ type: "agent.message.end", messageId: "u2", role: "user", text: "next?" });
    fake.send({ type: "agent.status", busy: true });
    await s.waitForFrame((f) => /Thinking… 0s/.test(f));
    clock.t = 3_000;
    fake.send({ type: "agent.context", tokens: 1, contextWindow: 10, percent: 10 });
    await s.waitForFrame((f) => /Thinking… 3s/.test(f));
    fake.send({ type: "agent.message.start", messageId: "m4", role: "assistant" });
    fake.send({ type: "agent.message.delta", messageId: "m4", text: "First token." });
    await frameWhere(s, (f) => f.includes("First token.") && !f.includes("Thinking…"));
    fake.send({
      type: "agent.message.end",
      messageId: "m4",
      role: "assistant",
      text: "First token.",
    });
    fake.send({
      type: "agent.tool.start",
      toolCallId: "t9",
      tool: "bash",
      args: { command: "ls" },
    });
    await s.waitForFrame((f) => /bash +ls/.test(f) && !f.includes("Thinking…"));
    clock.t = 5_000;
    fake.send({ type: "agent.tool.end", toolCallId: "t9", status: "ok", summary: "" });
    await s.waitForFrame((f) => /Thinking… 0s/.test(f));
    fake.send({ type: "agent.status", busy: false });
    await s.waitForFrame((f) => !f.includes("Thinking…"));
  });

  test("thinking orbs animate while the agent works and leave when it is idle", async () => {
    const fake = fakeClient();
    const clock = { t: 0 };
    setup = await testRender(
      () => <App client={fake.client} snapshot={snapshot} now={() => clock.t} />,
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    const s = setup;
    const braille = /[⠁-⣿]/;
    /** The chat pane's thinking line and the one under it (the orb is two rows). */
    const orbRows = (f: string) => {
      const lines = f.split("\n");
      const at = lines.findIndex((l) => l.includes("Thinking…"));
      return at < 0
        ? ""
        : lines
            .slice(at, at + 2)
            .map((l) => l.slice(0, 10))
            .join("\n");
    };
    expect(s.captureCharFrame()).not.toMatch(braille);
    fake.send({ type: "agent.status", busy: true });
    const first = orbRows(await s.waitForFrame((f) => braille.test(orbRows(f))));
    // No event comes in: the orb's own tick moves it.
    clock.t = 400;
    const moved = orbRows(await frameWhere(s, (f) => orbRows(f) !== first));
    expect(moved).toMatch(braille);
    expect(moved).not.toBe(first);
    fake.send({ type: "agent.status", busy: false });
    const idle = await s.waitForFrame((f) => !f.includes("Thinking…"));
    expect(idle).not.toMatch(braille);
  });

  test("the orb timer starts once per busy spell, not on every rail change", async () => {
    const real = globalThis.setInterval;
    let orbTimers = 0;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms < 1000) orbTimers++;
      return real(fn, ms);
    }) as typeof setInterval;
    try {
      const fake = fakeClient();
      setup = await testRender(() => <App client={fake.client} snapshot={snapshot} />, {
        width: 100,
        height: 24,
      });
      await setup.renderOnce();
      const s = setup;
      fake.send({ type: "agent.status", busy: true });
      await s.waitForFrame((f) => f.includes("Thinking…"));
      for (let i = 0; i < 3; i++) {
        fake.send({ type: "agent.tool.start", toolCallId: `t${i}`, tool: "read", args: {} });
        fake.send({ type: "agent.tool.end", toolCallId: `t${i}`, status: "ok", summary: "" });
      }
      fake.send({ type: "agent.context", tokens: 1, contextWindow: 10, percent: 10 });
      await s.renderOnce();
      expect(orbTimers).toBe(1);
    } finally {
      globalThis.setInterval = real;
    }
  });

  test("HAMNESS_NO_ANIMATION: a still orb that doesn't change with the clock", async () => {
    const fake = fakeClient();
    const clock = { t: 0 };
    setup = await testRender(
      () => <App client={fake.client} snapshot={snapshot} now={() => clock.t} animate={false} />,
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    const s = setup;
    fake.send({ type: "agent.status", busy: true });
    const orbOf = (f: string) => {
      const lines = f.split("\n");
      const at = lines.findIndex((l) => l.includes("Thinking…"));
      return lines.slice(at, at + 2).map((l) => l.slice(0, 6));
    };
    const before = orbOf(await s.waitForFrame((f) => /Thinking… 0s/.test(f)));
    expect(before.join("")).toMatch(/[⠁-⣿]/);
    clock.t = 2_000;
    fake.send({ type: "agent.context", tokens: 1, contextWindow: 10, percent: 10 });
    expect(orbOf(await s.waitForFrame((f) => /Thinking… 2s/.test(f)))).toEqual(before);
  });

  test("at a normal width the header path and the input hint fit, cut only between words", async () => {
    const deep = {
      ...snapshot,
      session: { ...snapshot.session, cwd: "/home/user/developer/ai/playground/claude-code-mods" },
    };
    setup = await testRender(
      () => <App client={fakeClient().client} snapshot={deep} home="/home/user" />,
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/hamness · ~\/…\/[\w/-]*claude-code-mods · anthropic\/claude-opus-5-5/);
    const hint = frame.split("\n").find((l) => l.includes("Ask hamness")) ?? "";
    expect(hint).toMatch(/Ask hamness…[^│]*\)/);
  });

  test("assistant replies render as Markdown, also while streaming; prompts stay plain", async () => {
    const fake = fakeClient();
    const md = {
      ...snapshot,
      items: [
        { kind: "message" as const, id: "u1", role: "user" as const, text: "keep **this** raw" },
        {
          kind: "message" as const,
          id: "a1",
          role: "assistant" as const,
          text: "## Plan\n\nSome **bold** and `code`.\n\n- first item\n- second item\n",
        },
      ],
    };
    const s = await render(fake.client, md);
    const frame = await frameWhere(s, (f) => f.includes("Some bold and code."));
    expect(frame).toContain("Some bold and code.");
    expect(frame).toContain("keep **this** raw");
    expect(frame).toContain("Plan");
    expect(frame).not.toContain("## Plan");
    expect(frame).toContain("first item");
    const spans = s.captureSpans().lines.flatMap((l) => l.spans);
    const bold = spans.find((sp) => sp.text.includes("bold"));
    expect((bold?.attributes ?? 0) & TextAttributes.BOLD).toBeTruthy();

    fake.send({ type: "agent.message.start", messageId: "a2", role: "assistant" });
    fake.send({ type: "agent.message.delta", messageId: "a2", text: "Now **str" });
    fake.send({ type: "agent.message.delta", messageId: "a2", text: "eaming** works" });
    expect(await frameWhere(s, (f) => f.includes("Now streaming works"))).toContain(
      "Now streaming works",
    );
  });

  test("ignores events for other sessions and events the snapshot already has", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.sendRaw({
      type: "agent.message.delta",
      sessionId: "other",
      seq: 99,
      messageId: "m3",
      text: " NOPE-OTHER",
    });
    fake.sendRaw({
      type: "agent.message.delta",
      sessionId: SID,
      seq: 3,
      messageId: "m3",
      text: " NOPE-OLD",
    });
    fake.send({ type: "agent.status", busy: true });
    await s.waitForFrame((f) => f.includes("working"));
    const frame = s.captureCharFrame();
    expect(frame).not.toContain("NOPE");
  });

  test("typing a prompt and pressing enter sends it to the session", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("fix the bug");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 1);
    expect(fake.prompts).toEqual(["fix the bug"]);
  });

  test("Shift+Enter and Ctrl+J add a new line; Enter sends the whole prompt", async () => {
    const fake = fakeClient();
    // Shift+Enter needs a terminal that reports it (the kitty keyboard protocol, on by default).
    const s = await render(fake.client, snapshot, { kittyKeyboard: true });
    await s.mockInput.typeText("line one");
    s.mockInput.pressEnter({ shift: true });
    await s.mockInput.typeText("line two");
    s.mockInput.pressKey("j", { ctrl: true });
    await s.mockInput.typeText("line three");
    await s.waitForFrame((f) => ["line one", "line two", "line three"].every((l) => f.includes(l)));
    expect(fake.prompts).toEqual([]);
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 1);
    expect(fake.prompts).toEqual(["line one\nline two\nline three"]);
    // The box is empty again, ready for the next prompt.
    await s.mockInput.typeText("next");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 2);
    expect(fake.prompts[1]).toBe("next");
  });

  test("without the kitty protocol, Ctrl+J (a linefeed) still adds a new line", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("one");
    s.mockInput.pressKey("j", { ctrl: true });
    await s.mockInput.typeText("two");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 1);
    expect(fake.prompts).toEqual(["one\ntwo"]);
  });

  test("auto mode: the header shows the judge's state; /judge resume turns it back on", async () => {
    const fake = fakeClient();
    const auto = {
      ...snapshot,
      session: { ...snapshot.session, mode: "auto" as const, judge: "on" as const },
    };
    const s = await render(fake.client, auto);
    expect(s.captureCharFrame()).toContain("judge on");
    fake.send({ type: "safety.judge", state: "paused", reason: "asked 3 times" });
    await s.waitForFrame((f) => f.includes("judge paused"));
    await s.mockInput.typeText("/judge resume");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("judge on"));
    expect(fake.resumed).toEqual([SID]);
    expect(fake.prompts).toEqual([]);
    fake.send({ type: "safety.judge", state: "over-budget", reason: "judge budget reached" });
    await s.waitForFrame((f) => f.includes("judge over budget"));
    fake.send({ type: "safety.judge", state: "no-key", reason: "no key" });
    await s.waitForFrame((f) => f.includes("judge off: no key"));
  });

  test("no judge state outside auto mode", async () => {
    const s = await render(fakeClient().client);
    expect(s.captureCharFrame()).not.toContain("judge");
  });

  test("/task, /override and /abandon go to the daemon, not to the agent", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    for (const line of ["/task ship the parser", "/override checked by hand", "/abandon"]) {
      await s.mockInput.typeText(line);
      s.mockInput.pressEnter();
    }
    await s.waitFor(() => fake.actions.length === 3);
    expect(fake.actions).toEqual([
      { kind: "start", goal: "ship the parser" },
      { kind: "override", reason: "checked by hand" },
      { kind: "abandon" },
    ]);
    expect(fake.prompts).toEqual([]);
    // A refused action shows the daemon's reason.
    await s.waitFor(() => s.captureCharFrame().includes("no open task"));
  });

  test("/task without a goal says how to use it", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/task");
    s.mockInput.pressEnter();
    await s.waitFor(() => s.captureCharFrame().includes("/task <goal>"));
    expect(fake.actions).toEqual([]);
  });

  test("/help lists every slash command and key, without prompting the agent", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/help");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("/judge resume"));
    const frame = s.captureCharFrame();
    for (const text of [
      "/task <goal>",
      "/override [reason]",
      "/abandon [reason]",
      "/model",
      "Ctrl+R",
    ]) {
      expect(frame).toContain(text);
    }
    expect(fake.prompts).toEqual([]);
    // Esc closes it (a lone Esc is only known after the escape-sequence timeout).
    s.mockInput.pressEscape();
    const deadline = Date.now() + 2000;
    while (s.captureCharFrame().includes("/judge resume") && Date.now() < deadline) {
      await Bun.sleep(20);
      await s.renderOnce();
    }
    expect(s.captureCharFrame()).not.toContain("/judge resume");
  });

  test("an unknown slash command says so instead of going to the agent", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/frobnicate now");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("unknown command /frobnicate"));
    expect(fake.prompts).toEqual([]);
    // A path is a prompt, not a command.
    await s.mockInput.typeText("/work/demo/notes.txt what is in it?");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 1);
  });
});
