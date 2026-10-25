import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionSnapshot } from "../events/types.ts";
import { addSystemLine, applyEvent, initialState, waitingForModel } from "./chat-state.ts";

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

  test("waiting for the model: from the prompt to the first token, and between tool calls", () => {
    const state = initialState({ ...snapshot, session: { ...snapshot.session, busy: false } });
    let seq = 0;
    const send = (body: Record<string, unknown>) =>
      applyEvent(state, { sessionId: SID, seq: ++seq, agentId: MAIN, ...body } as AgentEvent);

    expect(waitingForModel(state)).toBe(false);
    send({ type: "agent.message.start", messageId: "u1", role: "user" });
    send({ type: "agent.message.end", messageId: "u1", role: "user", text: "hi" });
    send({ type: "agent.status", busy: true });
    expect(waitingForModel(state)).toBe(true);
    // A reply that has started but has no text yet still shows nothing.
    send({ type: "agent.message.start", messageId: "m1", role: "assistant" });
    expect(waitingForModel(state)).toBe(true);
    send({ type: "agent.message.delta", messageId: "m1", text: "Let me look." });
    expect(waitingForModel(state)).toBe(false);
    send({ type: "agent.message.end", messageId: "m1", role: "assistant", text: "Let me look." });
    expect(waitingForModel(state)).toBe(true);
    send({ type: "agent.tool.start", toolCallId: "t1", tool: "read", args: { path: "a" } });
    expect(waitingForModel(state)).toBe(false);
    send({ type: "agent.tool.end", toolCallId: "t1", status: "ok", summary: "" });
    expect(waitingForModel(state)).toBe(true);
    send({ type: "agent.status", busy: false });
    expect(waitingForModel(state)).toBe(false);
  });

  test("not waiting while an approval is open: the prompt for it shows instead", () => {
    const state = initialState(snapshot);
    applyEvent(state, {
      sessionId: SID,
      seq: 1,
      agentId: MAIN,
      type: "safety.approval.request",
      approval: {
        id: "ap1",
        toolCallId: "t1",
        tool: "write",
        args: {},
        reason: "outside",
        suggestions: [],
        expiresAt: 0,
      },
    } as AgentEvent);
    expect(waitingForModel(state)).toBe(false);
  });

  test("a user stop adds a quiet Stopped. line; a subagent's stop stays in the rail", () => {
    const state = initialState(snapshot);
    let seq = 0;
    const send = (body: Record<string, unknown>) =>
      applyEvent(state, { sessionId: SID, seq: ++seq, agentId: MAIN, ...body } as AgentEvent);

    send({ type: "agent.stopped", agentId: SUB });
    expect(state.items).toEqual([]);
    send({ type: "agent.message.start", messageId: "m1", role: "assistant" });
    send({ type: "agent.message.end", messageId: "m1", role: "assistant", text: "Half" });
    send({ type: "agent.stopped" });
    send({ type: "agent.status", busy: false });
    expect(state.items.at(-1)).toMatchObject({ kind: "system", text: "Stopped.", tone: "muted" });
    expect(state.notice).toBeUndefined();
  });

  test("system lines get their own ids, in order", () => {
    const state = initialState(snapshot);
    addSystemLine(state, "Task opened: ship it", "ok");
    addSystemLine(state, "no open task", "error");
    expect(state.items).toEqual([
      { kind: "system", id: "sys-1", text: "Task opened: ship it", tone: "ok" },
      { kind: "system", id: "sys-2", text: "no open task", tone: "error" },
    ]);
  });
});
