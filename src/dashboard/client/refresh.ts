/**
 * Keeps the open view's numbers current without a reload: a quiet refresh about 2 s after the
 * events that change them (a run ends, a task changes, a decision is made), plus a slow poll
 * while the tab is visible. A hidden tab does nothing; it refreshes once on return if it missed
 * an event or a poll.
 */
import type { HamnessEvent } from "../../events/types.ts";

/** Events after which the stats, tasks or decisions may have changed. */
export function refreshesOn(e: HamnessEvent): boolean {
  switch (e.type) {
    case "agent.status":
      return !e.busy;
    case "task.start":
    case "task.end":
    case "task.drop":
    case "task.evidence":
    case "safety.approval.request":
    case "safety.approval.resolved":
    // A call the rules allowed starts at once; a denied one ends at once.
    case "agent.tool.start":
    case "agent.tool.end":
      return true;
    default:
      return false;
  }
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
  now: () => number;
}

export interface RefresherOptions {
  refresh: () => void;
  hidden: () => boolean;
  debounceMs?: number;
  pollMs?: number;
  timers?: Timers;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class Refresher {
  private soon: unknown;
  private poll: unknown;
  private missed = false;
  private last: number;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly timers: Timers;

  constructor(private readonly opts: RefresherOptions) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.pollMs = opts.pollMs ?? 60_000;
    this.timers = opts.timers ?? realTimers;
    this.last = this.timers.now();
  }

  start(): void {
    this.last = this.timers.now();
    if (!this.opts.hidden()) this.armPoll(this.pollMs);
  }

  /** Something changed: refresh once, `debounceMs` after the first of a burst. */
  poke(): void {
    if (this.opts.hidden()) {
      this.missed = true;
      return;
    }
    if (this.soon !== undefined) return;
    this.soon = this.timers.set(() => {
      this.soon = undefined;
      this.fire();
    }, this.debounceMs);
  }

  visibilityChanged(): void {
    if (this.opts.hidden()) {
      if (this.soon !== undefined) this.missed = true;
      this.clear();
      return;
    }
    const since = this.timers.now() - this.last;
    if (this.missed || since >= this.pollMs) this.fire();
    else this.armPoll(this.pollMs - since);
  }

  private clear(): void {
    if (this.soon !== undefined) this.timers.clear(this.soon);
    if (this.poll !== undefined) this.timers.clear(this.poll);
    this.soon = undefined;
    this.poll = undefined;
  }

  private fire(): void {
    this.clear();
    this.missed = false;
    this.last = this.timers.now();
    this.armPoll(this.pollMs);
    this.opts.refresh();
  }

  private armPoll(ms: number): void {
    if (this.poll !== undefined) this.timers.clear(this.poll);
    this.poll = this.timers.set(() => {
      this.poll = undefined;
      this.fire();
    }, ms);
  }
}
