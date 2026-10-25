/**
 * Keeps the open view's numbers current without a reload: a quiet refresh once the events that
 * change them (a run ends, a task changes, a decision is made) have been quiet for 2 s, at most
 * 15 s after the first of a burst, plus a slow poll while the tab is visible. A hidden tab does
 * nothing; it refreshes once on return if it missed an event or a poll. A refresh the page
 * skips (the user is typing, say) is tried again after the debounce.
 */
import type { HamnessEvent } from "../../events/types.ts";

/**
 * Events after which the view's data may have changed. Tool calls are each a safety decision,
 * so they count on the Decisions view only: elsewhere a busy run would refresh all the time.
 */
export function refreshesOn(e: HamnessEvent, view?: string): boolean {
  switch (e.type) {
    case "agent.status":
      return !e.busy;
    case "task.start":
    case "task.end":
    case "task.drop":
    case "task.evidence":
    case "safety.approval.request":
    case "safety.approval.resolved":
      return true;
    case "agent.tool.start":
    case "agent.tool.end":
      return view === "decisions";
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
  /** Refreshes the view. False (or a promise of false) means it skipped, to be tried again. */
  refresh: () => boolean | undefined | Promise<boolean | undefined>;
  hidden: () => boolean;
  debounceMs?: number;
  maxWaitMs?: number;
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
  /** When the first event of the current burst came, for the max wait. */
  private burstStart: number | undefined;
  private missed = false;
  private last: number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly timers: Timers;

  constructor(private readonly opts: RefresherOptions) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 60_000;
    this.timers = opts.timers ?? realTimers;
    this.last = this.timers.now();
  }

  start(): void {
    this.last = this.timers.now();
    if (!this.opts.hidden()) this.armPoll(this.pollMs);
  }

  /** Something changed: refresh once things are quiet for `debounceMs`, within `maxWaitMs`. */
  poke(): void {
    if (this.opts.hidden()) {
      this.missed = true;
      return;
    }
    const now = this.timers.now();
    this.burstStart ??= now;
    const wait = Math.min(this.debounceMs, this.burstStart + this.maxWaitMs - now);
    if (this.soon !== undefined) this.timers.clear(this.soon);
    this.soon = this.timers.set(
      () => {
        this.soon = undefined;
        this.fire();
      },
      Math.max(0, wait),
    );
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
    this.burstStart = undefined;
  }

  private fire(): void {
    this.clear();
    this.missed = false;
    this.last = this.timers.now();
    this.armPoll(this.pollMs);
    const done = this.opts.refresh();
    if (done === false) this.skipped();
    else if (done instanceof Promise)
      void done.then((ok) => {
        if (ok === false) this.skipped();
      });
  }

  /** The page did not refresh: remember it, and try again after the debounce. */
  private skipped(): void {
    this.missed = true;
    if (this.opts.hidden() || this.soon !== undefined) return;
    this.soon = this.timers.set(() => {
      this.soon = undefined;
      this.fire();
    }, this.debounceMs);
  }

  private armPoll(ms: number): void {
    if (this.poll !== undefined) this.timers.clear(this.poll);
    this.poll = this.timers.set(() => {
      this.poll = undefined;
      this.fire();
    }, ms);
  }
}
