import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { DaemonClient } from "../client/client.ts";
import type { AgentEvent, HamnessEvent, SessionSnapshot } from "../events/types.ts";
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
  const client: DaemonClient = {
    ready: Promise.resolve(),
    attach: async () => snapshot,
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {},
    models: async () => [],
    setModel: async () => snapshot,
    subscribe(onEvent) {
      listener = onEvent;
      return () => {};
    },
  };
  let seq = snapshot.seq;
  const send = (body: Record<string, unknown>) =>
    listener({ sessionId: SID, seq: ++seq, ...body } as AgentEvent);
  return { client, prompts, send, sendRaw: (e: HamnessEvent) => listener(e) };
}

async function render(client: DaemonClient) {
  setup = await testRender(() => <App client={client} snapshot={snapshot} />, {
    width: 100,
    height: 24,
  });
  await setup.renderOnce();
  return setup;
}

describe("TUI chat layout (headless)", () => {
  test("renders the transcript, a compact tool line, the input box and the rail placeholder", async () => {
    const s = await render(fakeClient().client);
    const frame = s.captureCharFrame();
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
    await s.waitForFrame((f) => f.includes("Streaming works."));
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
});
