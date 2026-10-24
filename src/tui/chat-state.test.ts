import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionSnapshot } from "../events/types.ts";
import { applyEvent, initialState } from "./chat-state.ts";

const SID = "s-1";
const MAIN = "a-main";
const SUB = "a-sub";

const snapshot: SessionSnapshot = {
  session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: true, mainAgentId: MAIN },
  seq: 0,
  items: [],
};

describe("chat state", () => {
  test("a subagent's messages, tools and status stay out of the chat; its approvals show", () => {
    const state = initialState(snapshot);
    let seq = 0;
    const send = (body: Record<string, unknown>) =>
      applyEvent(state, { sessionId: SID, seq: ++seq, ...body } as AgentEvent);

    send({ type: "agent.message.start", agentId: SUB, messageId: "m1", role: "assistant" });
    send({
      type: "agent.message.end",
      agentId: SUB,
      messageId: "m1",
      role: "assistant",
      text: "x",
    });
    send({ type: "agent.tool.start", agentId: SUB, toolCallId: "t1", tool: "read", args: {} });
    send({ type: "agent.status", agentId: SUB, busy: false });
    send({ type: "agent.error", agentId: SUB, message: "stopped" });
    send({
      type: "safety.approval.request",
      agentId: SUB,
      approval: {
        id: "ap1",
        toolCallId: "t2",
        tool: "write",
        args: {},
        reason: "outside",
        suggestions: [],
        expiresAt: 0,
        agentId: SUB,
      },
    });

    expect(state.items).toEqual([]);
    expect(state.session.busy).toBe(true);
    expect(state.notice).toBeUndefined();
    expect(state.approvals.map((a) => a.id)).toEqual(["ap1"]);

    send({ type: "agent.status", agentId: MAIN, busy: false });
    expect(state.session.busy).toBe(false);
  });
});
