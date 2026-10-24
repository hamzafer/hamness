import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { ModelInfo } from "../agent/models.ts";
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
  seq: 1,
  items: [],
};

const info = (id: string, name: string, input: number, output: number): ModelInfo => ({
  id,
  provider: id.split("/")[0] ?? "",
  name,
  contextWindow: 1_000_000,
  inputPerMTok: input,
  outputPerMTok: output,
  priced: true,
});

const MODELS = [
  info("anthropic/claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5),
  info("anthropic/claude-opus-5-5", "Claude Opus 5.5", 4, 20),
  info("openai/gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2),
];

function fakeClient(opts: { failSwitch?: string } = {}) {
  let listener: (e: HamnessEvent) => void = () => {};
  const switches: string[] = [];
  const prompts: string[] = [];
  let seq = snapshot.seq;
  const client: DaemonClient = {
    ready: Promise.resolve(),
    attach: async () => snapshot,
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {},
    models: async () => MODELS,
    setModel: async (_id, model) => {
      switches.push(model);
      if (opts.failSwitch) throw new Error(opts.failSwitch);
      listener({ sessionId: SID, seq: ++seq, type: "agent.model", model } as AgentEvent);
      return { ...snapshot, session: { ...snapshot.session, model } };
    },
    subscribe(onEvent) {
      listener = onEvent;
      return () => {};
    },
  };
  return { client, switches, prompts };
}

async function render(client: DaemonClient) {
  setup = await testRender(() => <App client={client} snapshot={snapshot} />, {
    width: 100,
    height: 24,
  });
  await setup.renderOnce();
  return setup;
}

describe("/model in the TUI", () => {
  test("/model opens a picker of available models with prices; Enter switches to the highlighted one", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/model");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("openai/gpt-5.6-luna"));
    const frame = s.captureCharFrame();
    expect(frame).toContain("anthropic/claude-haiku-5-5");
    expect(frame).toMatch(/\$4 in \/ \$20 out/);
    // The picker starts on the current model; one step down is GPT-5.6 Luna.
    s.mockInput.pressArrow("down");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.switches.length === 1);
    expect(fake.switches).toEqual(["openai/gpt-5.6-luna"]);
    await s.waitForFrame(
      (f) => f.includes("· openai/gpt-5.6-luna") && !f.includes("Claude Haiku 5.5"),
    );
    expect(fake.prompts).toEqual([]);
  });

  test("/model provider/id switches directly, without the picker", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/model anthropic/claude-haiku-5-5");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.switches.length === 1);
    expect(fake.switches).toEqual(["anthropic/claude-haiku-5-5"]);
    await s.waitForFrame((f) => f.includes("· anthropic/claude-haiku-5-5"));
    expect(fake.prompts).toEqual([]);
  });

  test("Esc closes the picker without switching", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/model");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("openai/gpt-5.6-luna"));
    s.mockInput.pressEscape();
    // A lone Esc is only known to be one after the escape-sequence timeout, so poll a while.
    const deadline = Date.now() + 2000;
    while (s.captureCharFrame().includes("openai/gpt-5.6-luna") && Date.now() < deadline) {
      await Bun.sleep(20);
      await s.renderOnce();
    }
    expect(s.captureCharFrame()).not.toContain("openai/gpt-5.6-luna");
    expect(fake.switches).toEqual([]);
  });

  test("a refused switch shows the daemon's reason", async () => {
    const fake = fakeClient({ failSwitch: "No API key for openai. Set OPENAI_API_KEY" });
    const s = await render(fake.client);
    await s.mockInput.typeText("/model openai/gpt-5.6-luna");
    s.mockInput.pressEnter();
    await s.waitForFrame((f) => f.includes("No API key for openai"));
  });
});
