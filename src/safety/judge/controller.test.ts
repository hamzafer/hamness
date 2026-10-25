import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOUR, seeder } from "../../../test/support/stats-seed.ts";
import { tempHome } from "../../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../../db/open.ts";
import type { JudgeState } from "../../events/types.ts";
import type { JudgeRequest, JudgeVerdict } from "../service.ts";
import type { BackendJudge } from "./anthropic.ts";
import { BACK_OFF, createJudgeController } from "./controller.ts";

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;
let seed: ReturnType<typeof seeder>;

beforeEach(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "hamness.sqlite"));
  seed = seeder(db.sqlite);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

// 14:00 local time on a fixed day.
const NOW = new Date(2026, 9, 24, 14, 0, 0).getTime();

const req = (sessionId = "s-1"): JudgeRequest => ({
  sessionId,
  cwd: "/work/demo",
  tool: "bash",
  args: { command: "mkdir build" },
  evaluation: { verdict: "undecided", reason: "no rule matches", suggestions: [] },
});

function setup(backend: BackendJudge | undefined, judgeConfig: Record<string, unknown> = {}) {
  writeFileSync(join(home.dir, "config.json"), JSON.stringify({ safety: { judge: judgeConfig } }));
  const states: Array<[string, JudgeState]> = [];
  const c = createJudgeController({
    db,
    dataDir: home.dir,
    ...(backend ? { backend } : {}),
    now: () => NOW,
    onState: (sessionId, state) => states.push([sessionId, state]),
  });
  return { ...c, states };
}

const allow: JudgeVerdict = {
  verdict: "allow",
  reason: "routine",
  category: "none",
  costMicros: 5,
};
const ask: JudgeVerdict = { verdict: "ask", reason: "risky", category: "unclear", costMicros: 5 };

describe("the judge controller", () => {
  test("passes the backend's verdict through, with the configured model", async () => {
    const models: Array<string | undefined> = [];
    const c = setup(
      async (_r, o) => {
        models.push(o?.model);
        return allow;
      },
      { model: "claude-sonnet-5-5" },
    );
    expect(await c.judge(req())).toEqual({ ...allow, model: "claude-sonnet-5-5" });
    expect(models).toEqual(["claude-sonnet-5-5"]);
    expect(c.state("s-1")).toBe("on");
    expect(c.states).toEqual([]);
  });

  test("an error or a timeout means ask", async () => {
    const failing = setup(async () => {
      throw new Error("529 overloaded");
    });
    expect(await failing.judge(req())).toMatchObject({
      verdict: "ask",
      reason: "the judge failed: 529 overloaded",
    });

    let aborted = false;
    const slow = setup(
      (_r, o) =>
        new Promise((resolve) => {
          o?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => resolve(allow), 1000);
        }),
      { timeoutSec: 0.02 },
    );
    expect(await slow.judge(req())).toMatchObject({
      verdict: "ask",
      reason: "the judge did not answer within 0.02s",
    });
    expect(aborted).toBe(true);
  });

  test("with no key the judge is off: undecided calls ask, and the state shows once", async () => {
    const c = setup(undefined);
    expect(c.state("s-1")).toBe("no-key");
    const v = await c.judge(req());
    expect(v).toMatchObject({ verdict: "ask", skipped: true });
    expect(v.reason).toContain("judge is off");
    await c.judge(req());
    expect(c.states).toEqual([["s-1", "no-key"]]);
  });

  test("over the daily budget (judge costs since local midnight) undecided calls ask", async () => {
    let calls = 0;
    const c = setup(
      async () => {
        calls++;
        return allow;
      },
      { dailyBudgetUsd: 0.001 },
    );
    // Yesterday's spend does not count; other sources never count.
    seed.decision({ at: NOW - 15 * HOUR, verdict: "allow", source: "judge", costMicros: 5000 });
    seed.decision({ at: NOW - HOUR, verdict: "allow", source: "rule", costMicros: 5000 });
    seed.decision({ at: NOW - HOUR, verdict: "allow", source: "judge", costMicros: 999 });
    expect(await c.judge(req())).toMatchObject(allow);
    expect(c.state("s-1")).toBe("on");

    seed.decision({ at: NOW - HOUR, verdict: "allow", source: "judge", costMicros: 1 });
    expect(c.state("s-1")).toBe("over-budget");
    expect(await c.judge(req())).toEqual({
      verdict: "ask",
      reason: "judge budget reached",
      skipped: true,
    });
    await c.judge(req());
    await c.judge(req("s-2"));
    expect(calls).toBe(1);
    // Once per session, not once per call.
    expect(c.states).toEqual([
      ["s-1", "over-budget"],
      ["s-2", "over-budget"],
    ]);
  });

  test(`${BACK_OFF} judge asks in a row pause the judge for that session, until resumed`, async () => {
    expect(BACK_OFF).toBe(3);
    const answers = [ask, ask, allow, ask, ask];
    let calls = 0;
    const c = setup(async (r) => {
      calls++;
      if (r.sessionId === "s-2") return allow;
      return answers.shift() ?? ask;
    });
    // ask, ask, allow resets; then ask, ask, ask pauses.
    for (let i = 0; i < 6; i++) await c.judge(req());
    expect(calls).toBe(6);
    expect(c.state("s-1")).toBe("paused");
    expect(c.states).toEqual([["s-1", "paused"]]);

    const v = await c.judge(req());
    expect(v).toMatchObject({ verdict: "ask", skipped: true });
    expect(v.reason).toContain("paused");
    expect(calls).toBe(6);

    // Other sessions keep their judge.
    expect(await c.judge(req("s-2"))).toMatchObject(allow);
    expect(c.state("s-2")).toBe("on");

    expect(c.resume("s-1")).toBe(true);
    expect(c.resume("s-1")).toBe(false);
    expect(c.state("s-1")).toBe("on");
    expect(c.states.at(-1)).toEqual(["s-1", "on"]);
    await c.judge(req());
    expect(calls).toBe(8);
  });

  test("errors count toward the back-off like asks", async () => {
    const c = setup(async () => {
      throw new Error("down");
    });
    for (let i = 0; i < BACK_OFF; i++) await c.judge(req());
    expect(c.state("s-1")).toBe("paused");
  });

  test("a timed-out call still counts its estimated input cost (S-L2)", async () => {
    const c = setup(() => new Promise(() => {}), { timeoutSec: 0.02 });
    const v = await c.judge(req());
    expect(v.verdict).toBe("ask");
    expect(v.costMicros).toBeGreaterThan(0);
  });

  test("calls running at once share the budget: the second one waits for none (S-L2)", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c = setup(
      async () => {
        calls++;
        await gate;
        return allow;
      },
      { dailyBudgetUsd: 0.001 },
    );
    seed.decision({ at: NOW - HOUR, verdict: "allow", source: "judge", costMicros: 999 });
    const first = c.judge(req());
    const second = await c.judge(req("s-2"));
    expect(second).toMatchObject({ verdict: "ask", skipped: true, reason: "judge budget reached" });
    release();
    expect(await first).toMatchObject(allow);
    expect(calls).toBe(1);
  });

  test("a ChatGPT plan judge counts calls, not dollars, against safety.judge.dailyCalls", async () => {
    const models: Array<string | undefined> = [];
    const plan = Object.assign(
      async (_r: JudgeRequest, o?: { model?: string }) => {
        models.push(o?.model);
        return { ...allow, costMicros: 0 };
      },
      { billing: "plan" as const, model: "openai-codex/gpt-5.6-luna" },
    );
    // An unpriced model and a spent dollar budget don't matter on the plan.
    const c = setup(plan, { dailyCalls: 2, dailyBudgetUsd: 0 });
    seed.decision({ at: NOW - 15 * HOUR, verdict: "allow", source: "judge", costMicros: 0 });
    seed.decision({ at: NOW - HOUR, verdict: "allow", source: "judge", costMicros: 0 });
    expect(c.state("s-1")).toBe("on");
    expect(await c.judge(req())).toMatchObject({ verdict: "allow", costMicros: 0 });
    expect(models).toEqual(["openai-codex/gpt-5.6-luna"]);

    seed.decision({ at: NOW - 1000, verdict: "allow", source: "judge", costMicros: 0 });
    expect(c.state("s-1")).toBe("over-budget");
    const v = await c.judge(req());
    expect(v).toMatchObject({ verdict: "ask", skipped: true });
    expect(v.reason).toContain("2 judge calls");
    expect(models).toHaveLength(1);
  });

  test("a plan judge that fails still asks", async () => {
    const plan = Object.assign(
      async (): Promise<JudgeVerdict> => {
        throw new Error("usage limit reached");
      },
      { billing: "plan" as const, model: "openai-codex/gpt-5.6-luna" },
    );
    const v = await setup(plan).judge(req());
    expect(v.verdict).toBe("ask");
    expect(v.reason).toContain("usage limit reached");
  });

  test("a judge model with no price counts as over budget, with the reason (S-L2)", async () => {
    let calls = 0;
    const c = setup(
      async () => {
        calls++;
        return allow;
      },
      { model: "mystery-model-1" },
    );
    expect(c.state("s-1")).toBe("over-budget");
    const v = await c.judge(req());
    expect(v).toMatchObject({ verdict: "ask", skipped: true });
    expect(v.reason).toContain("mystery-model-1 has no price");
    expect(calls).toBe(0);
  });
});
