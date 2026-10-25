import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type AgentRunner, type RunnerEvent, startAgentRunner, type ToolGuard } from "./runner.ts";

let home: ReturnType<typeof tempHome>;
let fake: FakeModel;
let runner: AgentRunner | undefined;
let events: RunnerEvent[];

beforeEach(async () => {
  home = tempHome();
  fake = await fakeModel(home.dir);
  events = [];
});
afterEach(() => {
  runner?.dispose();
  runner = undefined;
  home.cleanup();
});

async function start(guard?: ToolGuard) {
  runner = await startAgentRunner({
    cwd: home.dir,
    agentDir: join(home.dir, "pi"),
    models: fake,
    onEvent: (e) => events.push(e),
    contextFiles: false,
    ...(guard ? { guard } : {}),
  });
  return runner;
}

const ofType = <T extends RunnerEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === type);

describe("agent runner", () => {
  test("streams a reply as deltas and ends with its text, model and usage", async () => {
    fake.script([
      {
        text: "Hello from the fake model, streamed in pieces.",
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 },
      },
    ]);
    const r = await start();
    await r.prompt("hi");

    const deltas = ofType("assistant.delta").map((e) => e.text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Hello from the fake model, streamed in pieces.");

    const [end] = ofType("assistant.end");
    expect(end?.text).toBe("Hello from the fake model, streamed in pieces.");
    expect(end?.model).toBe("claude-opus-5-5");
    expect(end?.provider).toBe("fake");
    expect(end?.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 7 });
    expect(ofType("run.settled")).toHaveLength(1);
    expect(r.busy).toBe(false);
  });

  test("runs a tool call through the guard, then continues with its result", async () => {
    writeFileSync(join(home.dir, "notes.txt"), "the secret word is fig\n");
    fake.script([
      { text: "Reading.", tools: [{ name: "read", args: { path: "notes.txt" } }] },
      { text: "The word is fig." },
    ]);
    const seen: string[] = [];
    await (
      await start(async (call) => {
        seen.push(`${call.tool} ${JSON.stringify(call.args)}`);
        return { allow: true };
      })
    ).prompt("what is the word?");

    expect(seen).toEqual(['read {"path":"notes.txt"}']);
    const [toolStart] = ofType("tool.start");
    expect(toolStart?.tool).toBe("read");
    const [toolEnd] = ofType("tool.end");
    expect(toolEnd?.toolCallId).toBe(toolStart?.toolCallId as string);
    expect(toolEnd?.isError).toBe(false);
    expect(toolEnd?.summary).toContain("fig");
    expect(ofType("assistant.end").map((e) => e.text)).toEqual(["Reading.", "The word is fig."]);
  });

  test("a denied tool call never executes and the model is told why", async () => {
    fake.script([
      { tools: [{ name: "write", args: { path: "out.txt", content: "x" } }] },
      { text: "Understood." },
    ]);
    await (await start(async () => ({ allow: false, reason: "not today" }))).prompt("write it");

    expect(existsSync(join(home.dir, "out.txt"))).toBe(false);
    const [denied] = ofType("tool.denied");
    expect(denied?.reason).toBe("not today");
    const [end] = ofType("tool.end");
    expect(end?.isError).toBe(true);
    expect(end?.summary).toContain("not today");
  });

  test("a model error ends the message with the error", async () => {
    // Nothing scripted: the fake provider answers with an error.
    await (await start()).prompt("hi");
    const [end] = ofType("assistant.end");
    expect(end?.stopReason).toBe("error");
    expect(end?.error).toBeTruthy();
  });
});

describe("the model line in the system prompt", () => {
  /** Every system message Pi sent on call `i` (the prompt and its later patches), as JSON. */
  const systemText = (i: number) =>
    JSON.stringify(
      (fake.contexts[i]?.messages as Array<{ role: string }> | undefined)?.filter(
        (m) => m.role === "system",
      ) ?? [],
    );

  test("names the model, its display name and how it is billed", async () => {
    runner = await startAgentRunner({
      cwd: home.dir,
      agentDir: join(home.dir, "pi"),
      models: { ...fake, billing: () => ({ kind: "plan" as const }) },
      onEvent: (e) => events.push(e),
      contextFiles: false,
    });
    fake.script([{ text: "ok" }]);
    await runner.prompt("which model are you?");
    const sp = systemText(0);
    expect(sp).toContain("## Model (hamness)");
    expect(sp).toContain("fake/claude-opus-5-5");
    expect(sp).toContain(fake.model.name);
    expect(sp).toContain("ChatGPT plan");
  });

  test("follows a model switch on the next turn", async () => {
    fake = await fakeModel(home.dir, "claude-opus-5-5", { otherModels: ["claude-haiku-5-5"] });
    const r = await start();
    fake.script([{ text: "one" }, { text: "two" }]);
    await r.prompt("first");
    expect(systemText(0)).toContain("fake/claude-opus-5-5");
    const next = fake.runtime.getModel("fake", "claude-haiku-5-5");
    if (!next) throw new Error("no second model");
    await r.setModel(next);
    await r.prompt("second");
    const later = systemText(1);
    // The newest model line is the switched one.
    expect(later.lastIndexOf("fake/claude-haiku-5-5")).toBeGreaterThan(
      later.lastIndexOf("fake/claude-opus-5-5"),
    );
  });
});
