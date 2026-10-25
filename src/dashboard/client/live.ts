/**
 * What the daemon's agents are doing right now, from its event stream (`/v1/events`, the same
 * WebSocket the TUI uses). The page has no snapshot: one opened mid-run, or reconnected, picks a
 * run up from its next tool, text, check or approval event (see `LiveRuns`).
 */
import type { HamnessEvent } from "../../events/types.ts";
import { LiveRuns, ORB_LABEL } from "../../orbs/activity.ts";
import type { OrbState } from "../../orbs/index.ts";

/** What the orb means, in the user's words. */
export function orbLabel(state: OrbState): string {
  return ORB_LABEL[state];
}

/**
 * What the header's status region says: only the coarse changes (a run starts or ends, an
 * agent waits on the user), so a screen reader isn't told about every tool switch.
 */
export function announcement(state: OrbState | undefined): string {
  if (!state) return "Agents idle";
  return state === "listening" ? ORB_LABEL.listening : "Agent working";
}

/** The daemon as a whole, plus one `LiveRuns` per session for the task rows. */
export class SessionRuns {
  private all = new LiveRuns();
  private sessions = new Map<string, LiveRuns>();

  apply(e: HamnessEvent): void {
    this.all.apply(e);
    if (e.type === "daemon.stopping") {
      this.sessions.clear();
      return;
    }
    if (!("sessionId" in e)) return;
    // An answer can come from any session: every session drops the approval it waits on.
    if (e.type === "safety.approval.resolved") {
      for (const runs of this.sessions.values()) runs.apply(e);
      return;
    }
    let runs = this.sessions.get(e.sessionId);
    if (!runs) {
      runs = new LiveRuns();
      this.sessions.set(e.sessionId, runs);
    }
    runs.apply(e);
  }

  /** The orb for the header: any approval listens, else the newest busy agent's. */
  state(): OrbState | undefined {
    return this.all.state();
  }

  /** Agents with a run going or an approval waiting. */
  active(): number {
    return this.all.active();
  }

  session(id: string): OrbState | undefined {
    return this.sessions.get(id)?.state();
  }
}

export function eventsUrl(loc: { protocol: string; host: string }, token: string): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/v1/events?${new URLSearchParams({ token })}`;
}

/**
 * Keeps a WebSocket to the event stream open, reconnecting with backoff, and calls `onChange`
 * after each event. A dropped connection forgets every run (the daemon may have restarted).
 */
export function connectLive(
  token: () => string | null,
  runs: SessionRuns,
  onChange: (e?: HamnessEvent) => void,
) {
  let delay = 1000;
  const open = () => {
    const t = token();
    if (!t) return;
    const ws = new WebSocket(eventsUrl(location, t));
    ws.onopen = () => {
      delay = 1000;
    };
    ws.onmessage = (m) => {
      let e: HamnessEvent;
      try {
        e = JSON.parse(String(m.data)) as HamnessEvent;
        runs.apply(e);
      } catch {
        return;
      }
      onChange(e);
    };
    ws.onclose = () => {
      runs.apply({ type: "daemon.stopping" });
      onChange();
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };
  open();
}
