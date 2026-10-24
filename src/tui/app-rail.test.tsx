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
  session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: false, mainAgentId: "a-main" },
  seq: 2,
  items: [{ kind: "message", id: "m1", role: "user", text: "hello there" }],
  agents: [{ id: "a-main", kind: "main", tokens: 0, costMicros: 0 }],
};

function fakeClient() {
  let listener: (e: HamnessEvent) => void = () => {};
  const client: DaemonClient = {
    ready: Promise.resolve(),
    attach: async () => snapshot,
    prompt: async () => {},
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
    listener({ sessionId: SID, seq: ++seq, agentId: "a-main", ...body } as AgentEvent);
  return { client, send };
}

async function render(client: DaemonClient, clock: { t: number }) {
  setup = await testRender(() => <App client={client} snapshot={snapshot} now={() => clock.t} />, {
    width: 100,
    height: 24,
  });
  await setup.renderOnce();
  return setup;
}

describe("TUI side rail (headless)", () => {
  test("rows appear, update and finish live as tools run, and session cost adds up", async () => {
    const fake = fakeClient();
    const clock = { t: 0 };
    const s = await render(fake.client, clock);
    await s.waitForFrame((f) => f.includes("○ main"));

    clock.t = 1_000;
    fake.send({ type: "agent.status", busy: true });
    fake.send({
      type: "agent.tool.start",
      toolCallId: "t1",
      tool: "read",
      args: { path: "/work/demo/notes.txt" },
    });
    await s.waitForFrame((f) => f.includes("● main") && /read +notes\.txt/.test(f));

    fake.send({
      type: "agent.usage",
      modelCallId: "c1",
      messageId: "m2",
      provider: "fake",
      model: "m",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      costMicros: 836,
      priced: true,
    });
    fake.send({ type: "agent.context", tokens: 32_000, contextWindow: 128_000, percent: 25 });
    fake.send({ type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "fig" });
    clock.t = 4_000;
    fake.send({ type: "agent.status", busy: false });
    await s.waitForFrame((f) => /✓ main +3s/.test(f));
    const frame = s.captureCharFrame();
    expect(frame).toMatch(/cost +\$0\.0008/);
    expect(frame).toMatch(/132 tok/);
    expect(frame).toMatch(/ctx +▰{3}▱{7} +25%/);
  });

  test("Ctrl+R opens the rail full screen and returns to the chat", async () => {
    const fake = fakeClient();
    const s = await render(fake.client, { t: 0 });
    expect(s.captureCharFrame()).toContain("hello there");

    s.mockInput.pressKey("r", { ctrl: true });
    await s.waitForFrame((f) => f.includes("Ctrl+R back") && !f.includes("hello there"));

    s.mockInput.pressKey("r", { ctrl: true });
    await s.waitForFrame((f) => f.includes("hello there") && !f.includes("Ctrl+R back"));
  });
});
