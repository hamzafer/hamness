import { describe, expect, test } from "bun:test";
import { type ClockEnv, OrbClock } from "./orb-clock.ts";

function env(over: Partial<ClockEnv> = {}) {
  let pending: ((t: number) => void) | undefined;
  const e: ClockEnv & { frame(t: number): void; scheduled(): boolean } = {
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    caf: () => {
      pending = undefined;
    },
    hidden: () => false,
    reducedMotion: () => false,
    ...over,
    frame(t) {
      const cb = pending;
      pending = undefined;
      cb?.(t);
    },
    scheduled: () => pending !== undefined,
  };
  return e;
}

function orb() {
  const draws: (number | null)[] = [];
  return { draws, draw: (seconds: number | null) => draws.push(seconds), connected: true };
}

describe("orb clock", () => {
  test("one loop drives every orb from the same time", () => {
    const e = env();
    const clock = new OrbClock(e);
    const a = orb();
    const b = orb();
    clock.add(a);
    clock.add(b);
    e.frame(1000);
    e.frame(1500);
    expect(a.draws).toEqual([0, 0.5]);
    expect(b.draws).toEqual([0, 0.5]);
  });

  test("offscreen orbs are skipped; with none on screen the loop stops", () => {
    const e = env();
    const clock = new OrbClock(e);
    const a = orb();
    clock.add(a);
    e.frame(0);
    clock.setVisible(a, false);
    e.frame(16);
    expect(a.draws).toEqual([0]);
    expect(e.scheduled()).toBe(false);
    clock.setVisible(a, true);
    expect(e.scheduled()).toBe(true);
  });

  test("a hidden tab stops the loop, and it resumes where it left off", () => {
    let hidden = false;
    const e = env({ hidden: () => hidden });
    const clock = new OrbClock(e);
    const a = orb();
    clock.add(a);
    e.frame(0);
    e.frame(1000);
    hidden = true;
    clock.wake();
    e.frame(2000);
    expect(e.scheduled()).toBe(false);
    hidden = false;
    clock.wake();
    e.frame(60_000);
    // The time away does not count: the animation picks up after 1s, not 60s.
    expect(a.draws.at(-1)).toBeLessThan(1.1);
  });

  test("reduced motion paints one still frame and never loops", () => {
    const e = env({ reducedMotion: () => true });
    const clock = new OrbClock(e);
    const a = orb();
    clock.add(a);
    expect(a.draws).toEqual([null]);
    expect(e.scheduled()).toBe(false);
  });

  test("orbs that left the page are dropped", () => {
    const e = env();
    const clock = new OrbClock(e);
    const a = orb();
    clock.add(a);
    a.connected = false;
    e.frame(0);
    expect(a.draws).toEqual([]);
    expect(clock.size).toBe(0);
    expect(e.scheduled()).toBe(false);
  });
});
