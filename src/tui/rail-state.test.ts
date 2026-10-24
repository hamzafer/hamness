import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionSnapshot } from "../events/types.ts";
import { applyRailEvent, initialRail, sessionCostMicros } from "./rail-state.ts";

const SID = "s-1";
const MAIN = "a-main";

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: false, mainAgentId: MAIN },
    seq: 3,
    items: [],
    agents: [{ id: MAIN, kind: "main", tokens: 1200, costMicros: 5000 }],
    context: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
    ...over,
  };
}

/** Feeds events with rising seq numbers, each at its own clock time. */
function feed(snapshot = snap(), start = 1000) {
  const state = initialRail(snapshot, start);
  let seq = snapshot.seq;
  return {
    state,
    send(at: number, body: Record<string, unknown>) {
      applyRailEvent(state, { sessionId: SID, seq: ++seq, ...body } as AgentEvent, at);
    },
  };
}

const main = (s: ReturnType<typeof initialRail>) => s.agents[0];

describe("rail state", () => {
  test("starts from the snapshot: one idle main agent with its stored totals and context", () => {
    const s = initialRail(snap(), 1000);
    expect(s.agents).toHaveLength(1);
    expect(main(s)).toMatchObject({ id: MAIN, name: "main", status: "idle", tokens: 1200 });
    expect(sessionCostMicros(s)).toBe(5000);
    expect(s.context).toEqual({ tokens: 32_000, contextWindow: 128_000, percent: 25 });
  });

  test("a snapshot taken mid-run shows the main agent running its open tool", () => {
    const s = initialRail(
      snap({
        session: { id: SID, cwd: "/w", model: "m", busy: true, mainAgentId: MAIN },
        items: [
          { kind: "tool", id: "t1", tool: "read", args: { path: "a.ts" }, status: "ok" },
          { kind: "tool", id: "t2", tool: "edit", args: { path: "src/b.ts" }, status: "running" },
        ],
      }),
      1000,
    );
    expect(main(s)).toMatchObject({
      status: "running",
      tool: "edit",
      file: "b.ts",
      startedAt: 1000,
    });
  });

  test("a run: busy, tool with a file, usage, tool end, idle again", () => {
    const f = feed();
    f.send(2000, { type: "agent.status", busy: true, agentId: MAIN });
    expect(main(f.state)).toMatchObject({ status: "running", startedAt: 2000 });

    f.send(2500, {
      type: "agent.tool.start",
      toolCallId: "t1",
      tool: "read",
      args: { path: "/work/demo/src/tui/app.tsx" },
    });
    expect(main(f.state)).toMatchObject({ tool: "read", file: "app.tsx", toolRunning: true });

    f.send(3000, {
      type: "agent.usage",
      modelCallId: "c1",
      messageId: "m1",
      provider: "fake",
      model: "m",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      costMicros: 836,
      priced: true,
    });
    expect(main(f.state)?.tokens).toBe(1200 + 132);
    expect(sessionCostMicros(f.state)).toBe(5836);

    f.send(3100, { type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "" });
    expect(main(f.state)).toMatchObject({ tool: "read", file: "app.tsx", toolRunning: false });

    f.send(9000, { type: "agent.context", tokens: 64_000, contextWindow: 128_000, percent: 50 });
    expect(f.state.context?.percent).toBe(50);

    f.send(9500, { type: "agent.status", busy: false });
    expect(main(f.state)).toMatchObject({ status: "done", startedAt: 2000, endedAt: 9500 });
  });

  test("a bash call has no file; the newest running tool is the current one", () => {
    const f = feed();
    f.send(1, { type: "agent.status", busy: true });
    f.send(2, { type: "agent.tool.start", toolCallId: "t1", tool: "read", args: { path: "x.md" } });
    f.send(3, {
      type: "agent.tool.start",
      toolCallId: "t2",
      tool: "bash",
      args: { command: "bun test" },
    });
    expect(main(f.state)).toMatchObject({ tool: "bash", toolRunning: true });
    expect(main(f.state)?.file).toBeUndefined();
    // The older call finishing does not hide the one still running.
    f.send(4, { type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "" });
    expect(main(f.state)).toMatchObject({ tool: "bash", toolRunning: true });
  });

  test("an error marks the agent until its next run", () => {
    const f = feed();
    f.send(1, { type: "agent.status", busy: true });
    f.send(2, { type: "agent.error", message: "No API key for fake." });
    f.send(3, { type: "agent.status", busy: false });
    expect(main(f.state)).toMatchObject({ status: "error", error: "No API key for fake." });

    f.send(4, { type: "agent.status", busy: true });
    expect(main(f.state)?.status).toBe("running");
    expect(main(f.state)?.error).toBeUndefined();

    f.send(5, {
      type: "agent.message.end",
      messageId: "m9",
      role: "assistant",
      text: "",
      error: "overloaded",
    });
    f.send(6, { type: "agent.status", busy: false });
    expect(main(f.state)).toMatchObject({ status: "error", error: "overloaded" });
  });

  test("events for another agent get their own row; other sessions and old events are dropped", () => {
    const f = feed();
    f.send(1, { type: "agent.status", busy: true, agentId: "a-sub" });
    expect(f.state.agents.map((a) => [a.id, a.kind, a.status])).toEqual([
      [MAIN, "main", "idle"],
      ["a-sub", "subagent", "running"],
    ]);

    applyRailEvent(f.state, { sessionId: "other", seq: 99, type: "agent.status", busy: true }, 2);
    applyRailEvent(f.state, { sessionId: SID, seq: 1, type: "agent.status", busy: true }, 2);
    expect(main(f.state)?.status).toBe("idle");
  });

  test("a started subagent gets a named row that runs, then ends done or with its error", () => {
    const f = feed();
    f.send(1000, {
      type: "agent.start",
      agentId: "sub-a",
      name: "scout",
      parentAgentId: MAIN,
      model: "m",
    });
    f.send(1000, {
      type: "agent.start",
      agentId: "sub-b",
      name: "fixer",
      parentAgentId: MAIN,
      model: "m",
    });
    expect(f.state.agents.map((a) => [a.name, a.kind, a.status])).toEqual([
      ["main", "main", "idle"],
      ["scout", "subagent", "idle"],
      ["fixer", "subagent", "idle"],
    ]);
    f.send(1100, { type: "agent.status", agentId: "sub-a", busy: true });
    f.send(1100, { type: "agent.status", agentId: "sub-b", busy: true });
    f.send(1500, { type: "agent.status", agentId: "sub-a", busy: false });
    f.send(1600, { type: "agent.error", agentId: "sub-b", message: "stopped" });
    f.send(1600, { type: "agent.status", agentId: "sub-b", busy: false });
    expect(f.state.agents.slice(1).map((a) => [a.name, a.status, a.error])).toEqual([
      ["scout", "done", undefined],
      ["fixer", "error", "stopped"],
    ]);
  });

  test("subagents in the snapshot keep their names and where they got to", () => {
    const s = initialRail(
      snap({
        agents: [
          { id: MAIN, kind: "main", tokens: 0, costMicros: 0 },
          {
            id: "sub-a",
            kind: "subagent",
            name: "scout",
            status: "running",
            tokens: 10,
            costMicros: 7,
          },
          {
            id: "sub-b",
            kind: "subagent",
            name: "fixer",
            status: "done",
            tokens: 0,
            costMicros: 0,
          },
          {
            id: "sub-c",
            kind: "subagent",
            name: "lost",
            status: "aborted",
            tokens: 0,
            costMicros: 0,
          },
        ],
      }),
      1000,
    );
    expect(s.agents.map((a) => [a.name, a.status])).toEqual([
      ["main", "idle"],
      ["scout", "running"],
      ["fixer", "done"],
      ["lost", "error"],
    ]);
    expect(sessionCostMicros(s)).toBe(7);
  });
});
