import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentEvent, SessionSnapshot } from "../events/types.ts";
import { Rail, taskTone } from "./rail.tsx";
import {
  applyRailEvent,
  formatCost,
  formatElapsed,
  formatTokens,
  initialRail,
  type RailState,
} from "./rail-state.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

const SID = "s-1";
const MAIN = "a-main";
const snapshot: SessionSnapshot = {
  session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: false, mainAgentId: MAIN },
  seq: 0,
  items: [],
  agents: [{ id: MAIN, kind: "main", tokens: 1200, costMicros: 5000 }],
  context: { tokens: 64_000, contextWindow: 128_000, percent: 50 },
};

function stateAfter(events: Array<[number, Record<string, unknown>]>): RailState {
  const s = initialRail(snapshot, 0);
  let seq = 0;
  for (const [at, body] of events) {
    applyRailEvent(s, { sessionId: SID, seq: ++seq, ...body } as AgentEvent, at);
  }
  return s;
}

async function frameOf(state: RailState, now: number, opts: { width?: number } = {}) {
  setup = await testRender(() => <Rail state={state} now={now} />, {
    width: opts.width ?? 32,
    height: 16,
  });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

const rowLines = (frame: string) => frame.split("\n").filter((l) => /[○●✓✗] /.test(l));

describe("side rail (headless)", () => {
  test("idle: the main agent, a task placeholder, the context gauge and session cost", async () => {
    const frame = await frameOf(stateAfter([]), 0);
    expect(frame).toContain("○ main");
    expect(frame).toMatch(/task +none yet/);
    expect(frame).toMatch(/ctx +▰{5}▱{5} +50%/);
    expect(frame).toContain("64k / 128k");
    expect(frame).toMatch(/cost +\$0\.0050/);
    expect(frame).toMatch(/1\.2k tok +\$0\.0050/);
  });

  test("running a tool on a file: tool, file basename and live elapsed time", async () => {
    const state = stateAfter([
      [1_000, { type: "agent.status", busy: true }],
      [
        2_000,
        {
          type: "agent.tool.start",
          toolCallId: "t1",
          tool: "edit",
          args: { path: "/work/demo/src/tui/app.tsx" },
        },
      ],
    ]);
    const frame = await frameOf(state, 65_000);
    const [row] = rowLines(frame);
    expect(row).toMatch(/● main +1m04s/);
    expect(frame).toMatch(/edit +app\.tsx/);
    expect(frame).not.toContain("/work/demo/src");
  });

  test("finished: a check mark, no current tool and the run's final time", async () => {
    const state = stateAfter([
      [1_000, { type: "agent.status", busy: true }],
      [
        1_500,
        { type: "agent.tool.start", toolCallId: "t1", tool: "bash", args: { command: "ls" } },
      ],
      [2_000, { type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "" }],
      [
        3_000,
        {
          type: "agent.usage",
          modelCallId: "c",
          messageId: "m",
          provider: "fake",
          model: "m",
          inputTokens: 800,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: 20_000,
          priced: true,
        },
      ],
      [8_000, { type: "agent.status", busy: false }],
    ]);
    const frame = await frameOf(state, 99_000);
    const [row] = rowLines(frame);
    expect(row).toMatch(/✓ main +7s/);
    expect(frame).not.toMatch(/bash/);
    expect(frame).toMatch(/2k tok +\$0\.025/);
    expect(frame).toMatch(/cost +\$0\.025/);
  });

  test("error: a cross and the reason", async () => {
    const state = stateAfter([
      [1_000, { type: "agent.status", busy: true }],
      [1_200, { type: "agent.error", message: "No API key for fake. Set FAKE_API_KEY" }],
      [1_300, { type: "agent.status", busy: false }],
    ]);
    const frame = await frameOf(state, 5_000);
    expect(rowLines(frame)[0]).toMatch(/✗ main/);
    expect(frame).toContain("No API key");
  });

  test("a subagent gets its own row under the main agent", async () => {
    const state = stateAfter([[1_000, { type: "agent.status", busy: true, agentId: "a-xyz123" }]]);
    const rows = rowLines(await frameOf(state, 3_000));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("○ main");
    expect(rows[1]).toMatch(/● xyz123 +2s/);
  });

  test("unknown context fill shows a question mark instead of a gauge", async () => {
    const state = initialRail(
      { ...snapshot, context: { tokens: null, contextWindow: 1, percent: null } },
      0,
    );
    const frame = await frameOf(state, 0);
    expect(frame).toMatch(/ctx +\?/);
  });
});

describe("rail number formats", () => {
  test("elapsed, tokens and cost read at a glance", () => {
    expect([0, 4_900, 64_000, 3_720_000].map(formatElapsed)).toEqual([
      "0s",
      "4s",
      "1m04s",
      "1h02m",
    ]);
    expect([950, 1_200, 12_345, 128_000, 2_500_000].map(formatTokens)).toEqual([
      "950",
      "1.2k",
      "12.3k",
      "128k",
      "2.5M",
    ]);
    expect([836, 20_000, 1_234_567].map(formatCost)).toEqual(["$0.0008", "$0.020", "$1.23"]);
  });
});

describe("the task slot", () => {
  const withTask = (task: NonNullable<RailState["task"]>) => {
    const s = stateAfter([]);
    s.task = task;
    return s;
  };

  test("shows the goal, outcome and evidence count", async () => {
    const frame = await frameOf(
      withTask({
        id: "t",
        goal: "fix parser",
        implicit: false,
        outcome: "open",
        evidence: 2,
        passed: 1,
      }),
      0,
    );
    expect(frame).toMatch(/task +fix parser/);
    expect(frame).toMatch(/open · 1\/2 proof/);
  });

  test("unverified is red, verified and open are not", () => {
    const t = { id: "t", goal: "g", implicit: false, evidence: 0, passed: 0 };
    expect(taskTone({ ...t, outcome: "unverified" })).toBe("error");
    expect(taskTone({ ...t, outcome: "verified" })).toBe("ok");
    expect(taskTone({ ...t, outcome: "open" })).toBe("muted");
    expect(taskTone({ ...t, outcome: "overridden" })).toBe("text");
  });

  test("a proof check shows as its own row: running with its time, then how it ended (P-M3)", async () => {
    const start = {
      type: "check.start",
      taskId: "t1",
      evidenceId: "e1",
      kind: "command",
      label: "bun test",
    };
    const running = await frameOf(stateAfter([[1000, start]]), 4000, { width: 40 });
    expect(running).toMatch(/● check {2}bun test +3s/);
    await setup?.dispose();
    setup = undefined;
    const ended = await frameOf(
      stateAfter([
        [1000, start],
        [
          2500,
          {
            type: "check.end",
            taskId: "t1",
            evidenceId: "e1",
            status: "failed",
            summary: "exit 1 in 1500ms",
          },
        ],
      ]),
      9000,
      { width: 40 },
    );
    expect(ended).toMatch(/✗ check {2}bun test +1s/);
    expect(ended).toContain("failed: exit 1 in 1500ms");
  });
});
