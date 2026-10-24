import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { costMicros } from "../models/prices.ts";
import { resolveModels } from "./models.ts";
import { type RunnerEvent, startAgentRunner } from "./runner.ts";

// A real Claude call. Runs only when ANTHROPIC_API_KEY is set; never reads the Keychain.
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

test.skipIf(!hasKey)(
  "live: Claude Haiku answers and reports usage",
  async () => {
    const models = await resolveModels({
      dataDir: home.dir,
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        HAMNESS_MODEL: "anthropic/claude-haiku-5-5",
      },
    });
    const events: RunnerEvent[] = [];
    const runner = await startAgentRunner({
      cwd: home.dir,
      agentDir: join(home.dir, "pi"),
      models,
      contextFiles: false,
      onEvent: (e) => events.push(e),
    });
    try {
      await runner.prompt("Reply with the single word: ok");
    } finally {
      runner.dispose();
    }
    const end = events.find((e) => e.type === "assistant.end");
    if (end?.type !== "assistant.end") throw new Error("no reply");
    expect(end.error).toBeUndefined();
    expect(end.text.toLowerCase()).toContain("ok");
    expect(end.usage.output).toBeGreaterThan(0);
    expect(costMicros(end.model, end.usage)).toBeGreaterThan(0);
  },
  60_000,
);
