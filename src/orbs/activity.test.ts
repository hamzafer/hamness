import { describe, expect, test } from "bun:test";
import type { AgentEvent, HamnessEvent } from "../events/types.ts";
import { type Activity, activityOrbState, LiveRuns, toolOrbState } from "./activity.ts";

const idle: Activity = { running: false, approvals: 0, streaming: false, checking: false };
const busy: Activity = { ...idle, running: true };

describe("orb state from what the agent is doing", () => {
  test("tools: reading and searching, editing, everything else", () => {
    for (const t of ["read", "grep", "find", "glob", "ls", "Read", "Grep"])
      expect(toolOrbState(t)).toBe("searching");
    for (const t of ["edit", "write", "Edit", "MultiEdit"]) expect(toolOrbState(t)).toBe("shaping");
    for (const t of ["bash", "agent_start", "web_fetch"]) expect(toolOrbState(t)).toBe("working");
  });

  test("no orb while idle; an approval listens even then", () => {
    expect(activityOrbState(idle)).toBeUndefined();
    expect(activityOrbState({ ...idle, approvals: 1 })).toBe("listening");
  });

  test("a run: approval, then tool, then check, then streaming text, else waiting on the model", () => {
    expect(activityOrbState(busy)).toBe("solving");
    expect(activityOrbState({ ...busy, streaming: true })).toBe("composing");
    expect(activityOrbState({ ...busy, streaming: true, checking: true })).toBe("working");
    expect(activityOrbState({ ...busy, checking: true, tool: "grep" })).toBe("searching");
    expect(activityOrbState({ ...busy, tool: "edit", approvals: 1 })).toBe("listening");
  });
});

describe("live runs (the dashboard's view of the event stream)", () => {
  let seq = 0;
  const ev = (body: Record<string, unknown>, sessionId = "s-1") =>
    ({ sessionId, seq: ++seq, ...body }) as AgentEvent;

  test("follows the newest run through its phases, and ends with it", () => {
    const live = new LiveRuns();
    expect(live.state()).toBeUndefined();
    live.apply({ type: "daemon.hello", version: "0", pid: 1, schemaVersion: 1 } as HamnessEvent);
    live.apply(ev({ type: "agent.status", busy: true }));
    expect(live.state()).toBe("solving");
    live.apply(ev({ type: "agent.message.start", messageId: "m1", role: "assistant" }));
    live.apply(ev({ type: "agent.message.delta", messageId: "m1", text: "Hi" }));
    expect(live.state()).toBe("composing");
    live.apply(ev({ type: "agent.message.end", messageId: "m1", role: "assistant", text: "Hi" }));
    live.apply(ev({ type: "agent.tool.start", toolCallId: "t1", tool: "read", args: {} }));
    expect(live.state()).toBe("searching");
    live.apply(ev({ type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "" }));
    expect(live.state()).toBe("solving");
    live.apply(ev({ type: "agent.status", busy: false }));
    expect(live.state()).toBeUndefined();
    expect(live.active()).toBe(0);
  });

  test("an approval anywhere listens; a subagent's run keeps the orb on after main stops", () => {
    const live = new LiveRuns();
    live.apply(ev({ type: "agent.status", busy: true }));
    live.apply(ev({ type: "agent.status", busy: true, agentId: "a-sub" }));
    live.apply(
      ev({ type: "agent.tool.start", agentId: "a-sub", toolCallId: "t", tool: "edit", args: {} }),
    );
    expect(live.state()).toBe("shaping");
    live.apply(ev({ type: "safety.approval.request", agentId: "a-sub", approval: { id: "ap1" } }));
    expect(live.state()).toBe("listening");
    live.apply(
      ev({ type: "safety.approval.resolved", approvalId: "ap1", decision: "allow", by: "user" }),
    );
    expect(live.state()).toBe("shaping");
    live.apply(ev({ type: "agent.status", busy: false }));
    expect(live.active()).toBe(1);
    live.apply(ev({ type: "daemon.stopping" } as unknown as Record<string, unknown>));
    expect(live.state()).toBeUndefined();
  });

  test("joining mid-run (or after a reconnect): any activity means the run is going", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "agent.tool.start", toolCallId: "t", tool: "grep", args: {} }, "searching"],
      [{ type: "agent.message.start", messageId: "m", role: "assistant" }, "solving"],
      [{ type: "agent.message.delta", messageId: "m", text: "x" }, "composing"],
      [
        { type: "check.start", taskId: "t", evidenceId: "e", kind: "command", label: "x" },
        "working",
      ],
      [{ type: "safety.approval.request", approval: { id: "ap" } }, "listening"],
    ];
    for (const [body, state] of cases) {
      const live = new LiveRuns();
      live.apply(ev(body));
      expect(live.state()).toBe(state as ReturnType<LiveRuns["state"]>);
    }
    const live = new LiveRuns();
    live.apply(ev({ type: "agent.message.delta", messageId: "m", text: "x" }));
    live.apply(ev({ type: "agent.status", busy: false }));
    expect(live.state()).toBeUndefined();
  });

  test("finished agents are forgotten; one still waiting on an approval is kept", () => {
    const live = new LiveRuns();
    live.apply(ev({ type: "agent.status", busy: true }));
    live.apply(ev({ type: "agent.status", busy: true, agentId: "a-sub" }));
    live.apply(ev({ type: "safety.approval.request", agentId: "a-sub", approval: { id: "ap" } }));
    live.apply(ev({ type: "agent.status", busy: false }));
    live.apply(ev({ type: "agent.status", busy: false, agentId: "a-sub" }));
    expect(live.tracked()).toBe(1);
    live.apply(
      ev({ type: "safety.approval.resolved", approvalId: "ap", decision: "deny", by: "user" }),
    );
    expect(live.tracked()).toBe(0);
    // Events after the run ended (usage, a late context) don't leave a row behind.
    live.apply(ev({ type: "agent.context", tokens: 1, contextWindow: 2, percent: 50 }));
    expect(live.tracked()).toBe(0);
  });
});
