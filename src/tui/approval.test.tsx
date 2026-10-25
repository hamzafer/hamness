import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { noCommands } from "../../test/support/tui-client.ts";
import type { DaemonClient, SessionCommands } from "../client/client.ts";
import type {
  AgentEvent,
  ApprovalDecision,
  HamnessEvent,
  PendingApproval,
  SessionSnapshot,
} from "../events/types.ts";
import { App } from "./app.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

const SID = "s-1";

const pending = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1",
  toolCallId: "t9",
  tool: "bash",
  args: { command: "mkdir -p out" },
  reason: "no rule matches `mkdir -p out`",
  suggestions: [{ tool: "bash", pattern: "mkdir *" }],
  expiresAt: Date.now() + 60_000,
  ...over,
});

function snapshotWith(
  extra: Partial<SessionSnapshot> = {},
  mode?: "ask" | "auto" | "yolo",
): SessionSnapshot {
  return {
    session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: true, ...(mode ? { mode } : {}) },
    seq: 1,
    items: [],
    ...extra,
  };
}

function fakeClient() {
  let listener: (e: HamnessEvent) => void = () => {};
  const answers: Array<[string, ApprovalDecision]> = [];
  const prompts: string[] = [];
  let aborts = 0;
  const client: DaemonClient & SessionCommands = {
    ...noCommands(),
    ready: Promise.resolve(),
    attach: async () => snapshotWith(),
    prompt: async (_id, text) => {
      prompts.push(text);
    },
    abort: async () => {
      aborts++;
    },
    models: async () => [],
    setModel: async () => snapshotWith(),
    answerApproval: async (id, decision) => {
      answers.push([id, decision]);
    },
    resumeJudge: async () => "on",
    task: async () => {
      throw new Error("no task actions in this test");
    },
    subscribe(onEvent) {
      listener = onEvent;
      return () => {};
    },
  };
  let seq = 1;
  const send = (body: Record<string, unknown>) =>
    listener({ sessionId: SID, seq: ++seq, ...body } as AgentEvent);
  return { client, answers, prompts, send, aborts: () => aborts };
}

async function render(client: DaemonClient & SessionCommands, snapshot = snapshotWith()) {
  setup = await testRender(() => <App client={client} snapshot={snapshot} approvalArmMs={0} />, {
    width: 100,
    height: 24,
  });
  await setup.renderOnce();
  return setup;
}

describe("approval prompt (headless)", () => {
  test("at 80x24 a 600-character command stays within half the screen; the choices and input show", async () => {
    const fake = fakeClient();
    setup = await testRender(
      () => <App client={fake.client} snapshot={snapshotWith()} approvalArmMs={0} />,
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    const command = `python3 -c "${"print('x'); ".repeat(60)}"`.slice(0, 600);
    expect(command.length).toBe(600);
    const reason = "The judge can't tell what this script does. ".repeat(8);
    fake.send({
      type: "safety.approval.request",
      approval: pending({
        args: { command },
        reason,
        suggestions: [{ tool: "bash", pattern: `python3 -c ${"x".repeat(80)}` }],
      }),
    });
    const frame = await setup.waitForFrame((f) => f.includes("[n] deny"));
    const lines = frame.split("\n");
    const top = lines.findIndex((l) => l.includes("approve this tool call"));
    const bottom = lines.findIndex((l, i) => i > top && l.trimStart().startsWith("└"));
    expect(bottom - top + 1).toBeLessThanOrEqual(12);
    expect(frame).toContain("[n] deny");
    expect(frame).toContain("Ask hamness");
    expect(frame).toContain("hamness · ");
    expect(frame).toContain("python3 -c");
    expect(frame).toContain("The judge can't tell");
    // The choices row stays one row, the pattern cut short.
    const choices = lines.find((l) => l.includes("[y] once")) ?? "";
    expect(choices).toContain("…");
  });

  test("keys typed in the first moments after an approval shows don't answer it", async () => {
    const fake = fakeClient();
    setup = await testRender(() => <App client={fake.client} snapshot={snapshotWith()} />, {
      width: 100,
      height: 24,
    });
    await setup.renderOnce();
    fake.send({ type: "safety.approval.request", approval: pending() });
    await setup.waitForFrame((f) => f.includes("[y] allow once"));
    setup.mockInput.pressKey("y");
    await Bun.sleep(30);
    expect(fake.answers).toEqual([]);
    await Bun.sleep(450);
    setup.mockInput.pressKey("y");
    await setup.waitFor(() => fake.answers.length === 1);
    expect(fake.answers).toEqual([["ap-1", "allow-once"]]);
  });

  test("an approval request shows the call, why it asks and the choices", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({ type: "safety.approval.request", approval: pending() });
    await s.waitForFrame((f) => f.includes("mkdir -p out"));
    const frame = s.captureCharFrame();
    expect(frame).toContain("bash");
    expect(frame).toContain("no rule matches");
    expect(frame).toContain("[y] allow once");
    expect(frame).toContain('[a] always allow bash "mkdir *"');
    expect(frame).toContain("[n] deny");
  });

  test("a judge ask with a long reason and a long command never draws one over the other", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    const command = `bash -c "$(printf %s ${"QUJD".repeat(30)} | base64 -d)" && echo the-command-tail`;
    const reason =
      "The command decodes a base64 string and executes the result via bash -c, so its actual " +
      "behavior is hidden and cannot be verified before running.\nThe user should confirm it.";
    fake.send({
      type: "safety.approval.request",
      approval: pending({ args: { command }, reason, suggestions: [] }),
    });
    const frame = await s.waitForFrame((f) => f.includes("[y] allow once"));
    const lines = frame.split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    // The command is whole, on its own lines, above the reason; the choices come last.
    expect(at("bash -c")).toBeGreaterThan(-1);
    expect(at("the-command-tail")).toBeGreaterThan(at("bash -c"));
    expect(at("The command decodes")).toBeGreaterThan(at("the-command-tail"));
    expect(frame).toContain("verified before running.");
    expect(frame).toContain("The user should confirm it.");
    expect(at("[y] allow once")).toBeGreaterThan(at("The user should confirm it."));
    // No reason text inside the command's rows.
    for (let i = at("bash -c"); i <= at("the-command-tail"); i++) {
      expect(lines[i]).not.toContain("decodes");
    }
  });

  test("y allows once; the key is not typed into the prompt box", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({ type: "safety.approval.request", approval: pending() });
    await s.waitForFrame((f) => f.includes("[y] allow once"));
    s.mockInput.pressKey("y");
    await s.waitFor(() => fake.answers.length === 1);
    expect(fake.answers).toEqual([["ap-1", "allow-once"]]);

    fake.send({
      type: "safety.approval.resolved",
      approvalId: "ap-1",
      decision: "allow",
      by: "user",
    });
    await s.waitForFrame((f) => !f.includes("[y] allow once"));
    // The input has focus again, and holds nothing from the answer.
    await s.mockInput.typeText("next");
    s.mockInput.pressEnter();
    await s.waitFor(() => fake.prompts.length === 1);
    expect(fake.prompts).toEqual(["next"]);
  });

  test("a allows always, n and Esc deny, and Esc does not stop the run", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({ type: "safety.approval.request", approval: pending({ id: "a1" }) });
    fake.send({ type: "safety.approval.request", approval: pending({ id: "a2" }) });
    fake.send({ type: "safety.approval.request", approval: pending({ id: "a3" }) });
    await s.waitForFrame((f) => f.includes("1 of 3"));
    s.mockInput.pressKey("a");
    await s.waitFor(() => fake.answers.length === 1);
    fake.send({
      type: "safety.approval.resolved",
      approvalId: "a1",
      decision: "allow",
      by: "user",
    });
    await s.waitForFrame((f) => f.includes("1 of 2"));
    s.mockInput.pressKey("n");
    await s.waitFor(() => fake.answers.length === 2);
    fake.send({ type: "safety.approval.resolved", approvalId: "a2", decision: "deny", by: "user" });
    await s.waitForFrame((f) => !f.includes(" of "));
    s.mockInput.pressEscape();
    // A lone Esc is only known to be one after the escape-sequence timeout, so poll a while.
    const deadline = Date.now() + 2000;
    while (fake.answers.length < 3 && Date.now() < deadline) await Bun.sleep(20);
    expect(fake.answers).toEqual([
      ["a1", "allow-always"],
      ["a2", "deny"],
      ["a3", "deny"],
    ]);
    expect(fake.aborts()).toBe(0);
  });

  test("without suggestions there is no 'always' choice", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({ type: "safety.approval.request", approval: pending({ suggestions: [] }) });
    await s.waitForFrame((f) => f.includes("[y] allow once"));
    expect(s.captureCharFrame()).not.toContain("[a]");
    s.mockInput.pressKey("a");
    await Bun.sleep(30);
    expect(fake.answers).toEqual([]);
  });

  test("a subagent's approval says which subagent asks", async () => {
    const fake = fakeClient();
    const s = await render(fake.client);
    fake.send({
      type: "safety.approval.request",
      agentId: "a-sub",
      approval: pending({ agentId: "a-sub", agentName: "scout" }),
    });
    await s.waitForFrame((f) => f.includes("from subagent scout"));
  });

  test("approvals pending at attach time show at once", async () => {
    const fake = fakeClient();
    const s = await render(fake.client, snapshotWith({ approvals: [pending()] }));
    await s.waitForFrame((f) => f.includes("[y] allow once"));
  });

  test("yolo mode shows a loud banner; the header keeps the judge's state", async () => {
    const yolo = snapshotWith({}, "yolo");
    const s = await render(fakeClient().client, {
      ...yolo,
      session: { ...yolo.session, judge: "paused" },
    });
    const frame = s.captureCharFrame();
    expect(frame).toContain("YOLO");
    expect(frame).toContain("Type /mode auto to leave.");
    expect(frame).not.toContain("/mode ask");
    expect(frame).toContain("judge paused");
    await setup?.dispose();
    setup = undefined;
    const calm = await render(fakeClient().client, snapshotWith({}, "auto"));
    expect(calm.captureCharFrame()).not.toContain("YOLO");
  });
});
