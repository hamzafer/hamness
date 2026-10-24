import type { HamnessEvent } from "../../src/events/types.ts";

/** Collects a daemon's WebSocket events and waits for the one a test needs. */
export async function eventLog(wsUrl: string, token: string) {
  const events: HamnessEvent[] = [];
  const ws = new WebSocket(`${wsUrl}/v1/events?token=${token}`);
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)) as HamnessEvent);

  async function waitFor(
    predicate: (e: HamnessEvent) => boolean,
    timeoutMs = 3000,
  ): Promise<HamnessEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`no matching event; got ${events.map((e) => e.type).join(", ")}`);
      }
      await Bun.sleep(5);
    }
  }

  await waitFor((e) => e.type === "daemon.hello");
  return {
    events,
    waitFor,
    ofType<T extends HamnessEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<HamnessEvent, { type: T }> => e.type === type);
    },
    close: () => ws.close(),
  };
}
