import { describe, expect, test } from "bun:test";
import type { HamnessEvent } from "../../events/types.ts";
import { eventsUrl, orbLabel, SessionRuns } from "./live.ts";

let seq = 0;
const ev = (sessionId: string, e: Record<string, unknown>) =>
  ({ sessionId, seq: ++seq, ...e }) as HamnessEvent;

describe("live sessions", () => {
  test("each session gets its own orb; the header gets the daemon's", () => {
    const runs = new SessionRuns();
    runs.apply(ev("s1", { type: "agent.status", busy: true }));
    runs.apply(ev("s2", { type: "agent.status", busy: true }));
    runs.apply(ev("s2", { type: "agent.tool.start", toolCallId: "t1", tool: "grep", args: {} }));
    expect(runs.session("s1")).toBe("solving");
    expect(runs.session("s2")).toBe("searching");
    expect(runs.session("s3")).toBeUndefined();
    expect(runs.state()).toBe("searching");
    expect(runs.active()).toBe(2);
    runs.apply(ev("s2", { type: "agent.status", busy: false }));
    expect(runs.session("s2")).toBeUndefined();
    expect(runs.state()).toBe("solving");
  });

  test("an approval answered from another session stops the waiting one listening", () => {
    const runs = new SessionRuns();
    runs.apply(ev("s1", { type: "agent.status", busy: true }));
    runs.apply(
      ev("s1", { type: "safety.approval.request", approval: { id: "a1" } as unknown as object }),
    );
    expect(runs.session("s1")).toBe("listening");
    runs.apply(ev("s2", { type: "safety.approval.resolved", approvalId: "a1", decision: "allow" }));
    expect(runs.session("s1")).toBe("solving");
  });

  test("a stopping daemon clears everything", () => {
    const runs = new SessionRuns();
    runs.apply(ev("s1", { type: "agent.status", busy: true }));
    runs.apply({ type: "daemon.stopping" });
    expect(runs.session("s1")).toBeUndefined();
    expect(runs.state()).toBeUndefined();
  });

  test("labels are plain words from the user's side", () => {
    expect(orbLabel("searching")).toBe("Searching the code");
    expect(orbLabel("shaping")).toBe("Editing files");
    expect(orbLabel("listening")).toBe("Waiting for you");
    expect(orbLabel("composing")).toBe("Writing a reply");
    expect(orbLabel("solving")).toBe("Thinking");
    expect(orbLabel("working")).toBe("Running tools");
  });

  test("the event stream URL is same-origin and carries the token", () => {
    expect(eventsUrl({ protocol: "http:", host: "127.0.0.1:4100" }, "abc")).toBe(
      "ws://127.0.0.1:4100/v1/events?token=abc",
    );
    expect(eventsUrl({ protocol: "https:", host: "localhost" }, "a b")).toBe(
      "wss://localhost/v1/events?token=a+b",
    );
  });
});
