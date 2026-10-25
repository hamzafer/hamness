import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { writePlanLogin } from "../../../test/support/plan-login.ts";
import { tempHome } from "../../../test/support/temp-home.ts";
import { saveKey } from "../../agent/keys.ts";
import type { JudgeRequest } from "../service.ts";
import { chooseJudge, createPiJudge, judgeFromKeys } from "./index.ts";
import type { JudgeRuntime } from "./pi.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const config = (c: Record<string, unknown>) =>
  writeFileSync(join(home.dir, "config.json"), JSON.stringify(c));

describe("the judge's key", () => {
  test("no key in the env or the key file: no Anthropic judge", () => {
    expect(judgeFromKeys({ dataDir: home.dir, env: {} })).toBeUndefined();
    // A subscription token is not an API key.
    expect(
      judgeFromKeys({ dataDir: home.dir, env: { ANTHROPIC_OAUTH_TOKEN: "t" } }),
    ).toBeUndefined();
  });

  test("ANTHROPIC_API_KEY or the key file's anthropic entry: an API judge", () => {
    expect(judgeFromKeys({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } })).toBeFunction();
    saveKey(home.dir, "anthropic", "k");
    expect(judgeFromKeys({ dataDir: home.dir, env: {} })?.billing).toBe("api");
  });
});

describe("chooseJudge (ADR 0024)", () => {
  test("a ChatGPT plan login: gpt-5.6-luna on the plan, even with API keys around", async () => {
    writePlanLogin(home.dir, { tier: "go" });
    const j = await chooseJudge({
      dataDir: home.dir,
      env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k2" },
    });
    expect(j).toMatchObject({ model: "openai-codex/gpt-5.6-luna", billing: "plan" });
    expect(j.backend?.billing).toBe("plan");
    expect(j.backend?.model).toBe("openai-codex/gpt-5.6-luna");
  });

  test("another subscription login (Copilot) does not pick the judge", async () => {
    writePlanLogin(home.dir, { provider: "github-copilot" });
    expect((await chooseJudge({ dataDir: home.dir, env: {} })).backend).toBeUndefined();
  });

  test("an Anthropic key alone does not turn on a pay-per-token judge", async () => {
    const j = await chooseJudge({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } });
    expect(j.backend).toBeUndefined();
    expect(j.off).toContain("hamness login openai");
  });

  test("the user chose an API model: the Anthropic key's judge runs", async () => {
    const j = await chooseJudge({
      dataDir: home.dir,
      env: { ANTHROPIC_API_KEY: "k", HAMNESS_MODEL: "anthropic/claude-opus-5-5" },
    });
    expect(j).toMatchObject({ model: "claude-haiku-5-5", billing: "api" });
  });

  test("safety.judge.model wins: a plan model on the plan, an Anthropic one on its key", async () => {
    writePlanLogin(home.dir);
    config({ safety: { judge: { model: "openai-codex/gpt-5.6-terra" } } });
    expect(await chooseJudge({ dataDir: home.dir, env: {} })).toMatchObject({
      model: "openai-codex/gpt-5.6-terra",
      billing: "plan",
    });
    config({ safety: { judge: { model: "claude-haiku-5-5" } } });
    expect((await chooseJudge({ dataDir: home.dir, env: {} })).backend).toBeUndefined();
    expect(await chooseJudge({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } })).toMatchObject(
      { billing: "api" },
    );
  });
});

describe("the plan judge", () => {
  const req: JudgeRequest = {
    sessionId: "s",
    cwd: "/work",
    tool: "bash",
    args: { command: "mkdir build" },
    evaluation: { verdict: "undecided", reason: "no rule matches", suggestions: [] },
  };
  const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    }) as unknown as AssistantMessage;

  function runtime(text: string, stopReason?: AssistantMessage["stopReason"]) {
    const sent: Array<{ reasoning?: unknown; system?: string }> = [];
    const r: JudgeRuntime = {
      getModel: (p, id) => ({ provider: p, id }) as never,
      completeSimple: async (_m, ctx, opts) => {
        sent.push({
          reasoning: opts?.reasoning,
          ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
        });
        return reply(text, stopReason);
      },
    };
    return { r, sent };
  }

  test("a valid verdict passes, at $0, with low thinking", async () => {
    const { r, sent } = runtime(
      '```json\n{"verdict":"allow","reason":"routine build folder","category":"none"}\n```',
    );
    const judge = createPiJudge({ runtime: r, model: "openai-codex/gpt-5.6-luna" });
    expect(await judge(req)).toEqual({
      verdict: "allow",
      reason: "routine build folder",
      category: "none",
      costMicros: 0,
    });
    expect(sent[0]?.reasoning).toBe("low");
    expect(sent[0]?.system).toContain("untrusted data");
  });

  test("anything else asks; a model error throws so the controller asks", async () => {
    const bad = createPiJudge({ runtime: runtime("sure, allow it").r, model: "openai-codex/x" });
    expect((await bad(req)).verdict).toBe("ask");
    const cut = createPiJudge({ runtime: runtime("{", "length").r, model: "openai-codex/x" });
    expect((await cut(req)).reason).toContain("cut off");
    const err = createPiJudge({ runtime: runtime("", "error").r, model: "openai-codex/x" });
    await expect(err(req)).rejects.toThrow();
  });
});
