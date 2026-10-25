import { describe, expect, test } from "bun:test";
import type { HamnessEvent } from "../../events/types.ts";
import { Refresher, refreshesOn } from "./refresh.ts";

/** Fake timers: `tick(ms)` runs what is due, in order. */
function clock() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        due.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: unknown) => {
        due.delete(id as number);
      },
      now: () => now,
    },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

function setup(hidden = false) {
  const c = clock();
  const state = { hidden, runs: 0 };
  const r = new Refresher({
    refresh: () => {
      state.runs++;
    },
    hidden: () => state.hidden,
    debounceMs: 2000,
    pollMs: 60_000,
    timers: c.timers,
  });
  return { c, state, r };
}

describe("Refresher", () => {
  test("a burst of events makes one refresh, 2 s after the last (a trailing debounce)", () => {
    const { c, state, r } = setup();
    r.start();
    r.poke();
    c.tick(500);
    r.poke();
    c.tick(1000);
    r.poke();
    c.tick(1999);
    expect(state.runs).toBe(0);
    c.tick(1);
    expect(state.runs).toBe(1);
    c.tick(5000);
    expect(state.runs).toBe(1);
  });

  test("a stream of events that never goes quiet still refreshes every 15 s at most", () => {
    const { c, state, r } = setup();
    r.start();
    for (let t = 0; t < 14_000; t += 1000) {
      r.poke();
      c.tick(1000);
    }
    expect(state.runs).toBe(0);
    r.poke();
    c.tick(1000);
    expect(state.runs).toBe(1);
    for (let t = 0; t < 13_000; t += 1000) {
      r.poke();
      c.tick(1000);
    }
    expect(state.runs).toBe(1);
  });

  test("a refresh the page skipped is tried again after the debounce", () => {
    const c = clock();
    let runs = 0;
    let ok = false;
    const r = new Refresher({
      refresh: () => {
        runs++;
        return ok;
      },
      hidden: () => false,
      timers: c.timers,
    });
    r.start();
    r.poke();
    c.tick(2000);
    expect(runs).toBe(1);
    ok = true;
    c.tick(2000);
    expect(runs).toBe(2);
    c.tick(10_000);
    expect(runs).toBe(2);
  });

  test("a slow poll refreshes while visible, and a refresh restarts its clock", () => {
    const { c, state, r } = setup();
    r.start();
    c.tick(59_000);
    expect(state.runs).toBe(0);
    c.tick(1000);
    expect(state.runs).toBe(1);
    c.tick(30_000);
    r.poke();
    c.tick(2000);
    expect(state.runs).toBe(2);
    c.tick(59_000);
    expect(state.runs).toBe(2);
    c.tick(1000);
    expect(state.runs).toBe(3);
  });

  test("hidden: no poll and no event refresh; one refresh on return if anything was missed", () => {
    const { c, state, r } = setup(true);
    r.start();
    c.tick(300_000);
    r.poke();
    c.tick(10_000);
    expect(state.runs).toBe(0);
    expect(c.pending()).toBe(0);
    state.hidden = false;
    r.visibilityChanged();
    expect(state.runs).toBe(1);
  });

  test("hiding the tab stops the timers; coming back with nothing missed does not refresh", () => {
    const { c, state, r } = setup();
    r.start();
    state.hidden = true;
    r.visibilityChanged();
    expect(c.pending()).toBe(0);
    state.hidden = false;
    r.visibilityChanged();
    expect(state.runs).toBe(0);
    c.tick(60_000);
    expect(state.runs).toBe(1);
  });

  test("a poll due while hidden counts as missed", () => {
    const { c, state, r } = setup();
    r.start();
    state.hidden = true;
    r.visibilityChanged();
    c.tick(120_000);
    state.hidden = false;
    r.visibilityChanged();
    expect(state.runs).toBe(1);
  });
});

describe("refreshesOn", () => {
  const ev = (e: Record<string, unknown>) => ({ sessionId: "s", seq: 1, ...e }) as HamnessEvent;
  test("a run ending, a task changing and a decision being made refresh", () => {
    expect(refreshesOn(ev({ type: "agent.status", busy: false }))).toBe(true);
    expect(refreshesOn(ev({ type: "task.end" }))).toBe(true);
    expect(refreshesOn(ev({ type: "task.start" }))).toBe(true);
    expect(refreshesOn(ev({ type: "task.drop", taskId: "t" }))).toBe(true);
    expect(refreshesOn(ev({ type: "task.evidence" }))).toBe(true);
    expect(refreshesOn(ev({ type: "safety.approval.request" }))).toBe(true);
    expect(refreshesOn(ev({ type: "safety.approval.resolved" }))).toBe(true);
  });
  test("tool calls refresh only the Decisions view (each one is a decision)", () => {
    for (const type of ["agent.tool.start", "agent.tool.end"]) {
      expect(refreshesOn(ev({ type }), "decisions")).toBe(true);
      expect(refreshesOn(ev({ type }), "overview")).toBe(false);
      expect(refreshesOn(ev({ type }), "tasks")).toBe(false);
    }
  });
  test("streaming text and a run starting do not", () => {
    expect(refreshesOn(ev({ type: "agent.status", busy: true }))).toBe(false);
    expect(refreshesOn(ev({ type: "agent.message.delta" }))).toBe(false);
    expect(refreshesOn(ev({ type: "agent.context" }))).toBe(false);
    expect(refreshesOn({ type: "daemon.stopping" })).toBe(false);
  });
});
