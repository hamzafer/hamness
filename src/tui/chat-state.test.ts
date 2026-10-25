import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionSnapshot } from "../events/types.ts";
import {
  addCompactionFailure,
  addSystemLine,
  applyEvent,
  initialState,
  readableError,
  waitingForModel,
} from "./chat-state.ts";

const SID = "s-1";
const MAIN = "a-main";
const SUB = "a-sub";

const snapshot: SessionSnapshot = {
  session: { id: SID, cwd: "/work/demo", model: "fake/m", busy: true, mainAgentId: MAIN },
  seq: 0,
  items: [],
};

describe("readableError", () => {
  test("one readable line: prefixes go, API bodies unwrap, refusals said plainly", () => {
    expect(readableError("Compaction failed: Summarization failed: connect ECONNREFUSED")).toBe(
      "connect ECONNREFUSED",
    );
    expect(readableError("Summarization failed: Connection refused by host")).toBe(
      "Connection refused by host",
    );
    expect(
      readableError(
        'Summarization failed: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded. Retry in 30s."}}',
      ),
    ).toBe("Overloaded. Retry in 30s.");
    expect(readableError("The model refused to continue.")).toBe(
      "the model refused to write the summary.",
    );
    expect(readableError("API integrators: you can reduce refusals for your users")).toBe(
      "the model refused to write the summary.",
    );
    const long = `rate limited. ${"x".repeat(300)}`;
    expect(readableError(long).length).toBeLessThanOrEqual(200);
    expect(readableError("first line. Retry after 20s.\nstack trace")).toBe(
      "first line. Retry after 20s.",
    );
  });
});

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

  test("thinking level, name and safety mode follow their events", () => {
    const state = initialState(snapshot);
    let seq = 0;
    const send = (body: Record<string, unknown>) =>
      applyEvent(state, { sessionId: SID, seq: ++seq, ...body } as AgentEvent);
    send({ type: "agent.thinking", level: "high" });
    send({ type: "session.name", name: "parser work" });
    send({ type: "safety.mode", mode: "yolo", warning: "careful" });
    expect(state.session).toMatchObject({
      thinkingLevel: "high",
      name: "parser work",
      mode: "yolo",
    });
  });

  test("compaction: progress while it runs, then one line with the sizes", () => {
    const state = initialState(snapshot);
    let seq = 0;
    const send = (body: Record<string, unknown>) =>
      applyEvent(state, { sessionId: SID, seq: ++seq, ...body } as AgentEvent);
    send({ type: "agent.compaction.start", reason: "manual" });
    expect(state.compacting).toBe(true);
    send({
      type: "agent.compaction.end",
      reason: "manual",
      aborted: false,
      tokensBefore: 142_000,
      tokensAfter: 18_000,
    });
    expect(state.compacting).toBe(false);
    expect(state.items.at(-1)).toMatchObject({
      kind: "system",
      text: "Compacted: 142k → 18k tokens",
      tone: "ok",
    });
    send({ type: "agent.compaction.start", reason: "threshold" });
    send({
      type: "agent.compaction.end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 190_000,
      tokensAfter: 20_500,
    });
    expect(state.items.at(-1)).toMatchObject({
      text: "Context was nearly full, so it was compacted: 190k → 20.5k tokens",
    });
    send({ type: "agent.compaction.start", reason: "manual" });
    send({ type: "agent.compaction.end", reason: "manual", aborted: false, error: "no model" });
    expect(state.items.at(-1)).toMatchObject({
      text: "Compaction failed: no model",
      tone: "error",
    });
    // Pi's stacked prefixes go; a second report of the same failure adds nothing.
    const before = state.items.length;
    send({ type: "agent.compaction.start", reason: "manual" });
    send({
      type: "agent.compaction.end",
      reason: "manual",
      aborted: false,
      error: "Compaction failed: Summarization failed: rate limited. Retry in 20s.\nstack…",
    });
    addCompactionFailure(state, "Summarization failed: rate limited. Retry in 20s.");
    expect(state.items.length).toBe(before + 1);
    expect(state.items.at(-1)).toMatchObject({
      text: "Compaction failed: rate limited. Retry in 20s.",
    });
    send({ type: "agent.compaction.start", reason: "manual" });
    send({ type: "agent.compaction.end", reason: "manual", aborted: true });
    expect(state.items.at(-1)).toMatchObject({ text: "Compaction stopped.", tone: "muted" });
  });
});
