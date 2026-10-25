import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { noCommands } from "../../test/support/tui-client.ts";
import type { ModelInfo } from "../agent/models.ts";
import type { DaemonClient, SessionCommands } from "../client/client.ts";
import type { AgentEvent, HamnessEvent, SessionSnapshot } from "../events/types.ts";
import { App } from "./app.tsx";
import { priceLabel } from "./model-picker.tsx";

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
  const client: DaemonClient & SessionCommands = {
    ...noCommands(),
    ready: Promise.resolve(),
    attach: async () => snapshot,
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {},
    models: async () => MODELS,
    answerApproval: async () => {},
    resumeJudge: async () => "on",
    task: async () => {
      throw new Error("no task actions in this test");
    },
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

async function render(client: DaemonClient & SessionCommands) {
  setup = await testRender(() => <App client={client} snapshot={snapshot} approvalArmMs={0} />, {
    width: 100,
    height: 24,
  });
  await setup.renderOnce();
  return setup;
}

describe("billing labels (ADR 0023)", () => {
  test("the picker shows plan models at $0 (plan) and API models with their key; the header says plan", async () => {
    const plan: ModelInfo = {
      ...info("openai-codex/gpt-5.6-terra", "GPT-5.6 Terra", 2, 12),
      billing: { kind: "plan" },
    };
    const api: ModelInfo = {
      ...info("openai/gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2),
      billing: { kind: "api", source: "OPENAI_API_KEY" },
    };
    expect(priceLabel(plan)).toBe("$0 (plan)");
    expect(priceLabel(api)).toBe("API (pay per token, from OPENAI_API_KEY) · $0.2 in / $1.2 out");

    const fake = fakeClient();
    fake.client.models = async () => [plan, api];
    const planSnap: SessionSnapshot = {
      ...snapshot,
      session: { ...snapshot.session, model: "openai-codex/gpt-5.6-terra", billing: "plan" },
    };
    fake.client.attach = async () => planSnap;
    setup = await testRender(
      () => <App client={fake.client} snapshot={planSnap} approvalArmMs={0} />,
      { width: 120, height: 24 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("openai-codex/gpt-5.6-terra · plan");
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame((f) => f.includes("$0 (plan)"));
    expect(frame).toContain("API (pay per token, from OPENAI_API_KEY)");
    // Plan models first, as the daemon sends them.
    expect(frame.indexOf("openai-codex/gpt-5.6-terra")).toBeLessThan(
      frame.indexOf("openai/gpt-5.6-luna"),
    );
  });
});

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

  test("typing filters the models (letters are not keys), grouped by provider", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    await s.mockInput.typeText("/model");
    s.mockInput.pressEnter();
    const all = await s.waitForFrame((f) => f.includes("openai/gpt-5.6-luna"));
    // One heading per provider.
    expect(all).toMatch(/│ +anthropic +│/);
    expect(all).toMatch(/│ +openai +│/);
    // j and k type, they don't move.
    await s.mockInput.typeText("haik");
    const frame = await s.waitForFrame((f) => !f.includes("openai/gpt-5.6-luna"));
    expect(frame).toContain("anthropic/claude-haiku-5-5");
    expect(frame).not.toMatch(/│ +(● )?anthropic\/claude-opus-5-5/);
    expect(frame).toContain("haik");
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    s.mockInput.pressBackspace();
    await s.waitForFrame((f) => f.includes("openai/gpt-5.6-luna"));
    await s.mockInput.typeText("luna");
    await s.waitForFrame((f) => !f.includes("anthropic/claude-haiku-5-5"));
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.switches.length === 1);
    expect(fake.switches).toEqual(["openai/gpt-5.6-luna"]);
    expect(fake.prompts).toEqual([]);
  });

  test("at 80 columns: headings count toward the height, the footer fits one row", async () => {
    const many = [
      ...Array.from({ length: 7 }, (_, i) => info(`anthropic/model-a${i}`, `A ${i}`, 1, 2)),
      ...Array.from({ length: 7 }, (_, i) => info(`openai/model-o${i}`, `O ${i}`, 1, 2)),
    ];
    const fake = fakeClient();
    fake.client.models = async () => many;
    setup = await testRender(
      () => <App client={fake.client} snapshot={snapshot} approvalArmMs={0} />,
      { width: 80, height: 30 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame((f) => f.includes("Switch model"));
    const lines = frame.split("\n");
    const top = lines.findIndex((l) => l.includes("Switch model"));
    const bottom = lines.findIndex((l, i) => i > top && l.trimStart().startsWith("└"));
    // Eight list rows (headings included), the footer, the border.
    expect(bottom - top + 1).toBe(8 + 1 + 2);
    const footer = lines[bottom - 1] ?? "";
    expect(footer).toContain("Esc");
    expect(footer).toMatch(/\d+\/14/);
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
