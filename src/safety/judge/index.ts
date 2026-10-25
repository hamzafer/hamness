/**
 * Auto mode's judge (ADR 0006): a small model decides calls no rule decides. `anthropic.ts`
 * and `pi.ts` make the model call, `controller.ts` adds the deadline, budget and back-off.
 */

import { envKeyName, readKeyFile } from "../../agent/keys.ts";
import {
  configuredModel,
  createRuntime,
  parseModelSpec,
  planModel,
  planProviders,
} from "../../agent/models.ts";
import type { Env } from "../../config/paths.ts";
import { loadJudgeConfig } from "../config.ts";
import { anthropicClient, type BackendJudge, createAnthropicJudge } from "./anthropic.ts";
import { createPiJudge } from "./pi.ts";

export type { BackendJudge, JudgeCallOptions } from "./anthropic.ts";
export { createAnthropicJudge, DEFAULT_JUDGE_MODEL, parseVerdict } from "./anthropic.ts";
export { JUDGE_CATEGORIES, type JudgeCategory } from "./categories.ts";
export { BACK_OFF, BUDGET_REACHED, createJudgeController } from "./controller.ts";
export { createPiJudge } from "./pi.ts";

/** The Anthropic judge on `ANTHROPIC_API_KEY`, else the key file. Undefined with no key. */
export function judgeFromKeys(opts: { dataDir: string; env: Env }): BackendJudge | undefined {
  const envName = envKeyName("anthropic", opts.env);
  const key = envName ? opts.env[envName] : readKeyFile(opts.dataDir).anthropic;
  return key
    ? Object.assign(createAnthropicJudge({ client: anthropicClient(key) }), {
        billing: "api" as const,
      })
    : undefined;
}

/** The judge the daemon runs, and what doctor says about it. */
export interface JudgeChoice {
  backend?: BackendJudge;
  /** `provider/id` (or the Anthropic id) it judges with. */
  model?: string;
  billing?: "plan" | "api";
  /** Why it is off, when it is. */
  off?: string;
}

/**
 * Picks the judge (ADR 0023), never a pay-per-token one the user did not choose:
 * 1. `safety.judge.model` in the user config: that model (an Anthropic one needs a key).
 * 2. A ChatGPT plan login: the plan's cheap judge model, at $0 a call (a daily call cap applies).
 * 3. An Anthropic key, when the user chose an API model (HAMNESS_MODEL or defaultModel).
 * Otherwise the judge is off, and undecided calls ask.
 */
export async function chooseJudge(opts: { dataDir: string; env: Env }): Promise<JudgeChoice> {
  const config = loadJudgeConfig(opts.dataDir);
  const runtime = await createRuntime(opts.dataDir);
  const plans = await planProviders(runtime);
  const anthropic = () => judgeFromKeys(opts);

  if (config.modelSet) {
    const spec = parseModelSpec(config.model);
    if (spec && spec.provider !== "anthropic" && plans.includes(spec.provider)) {
      const model = `${spec.provider}/${spec.id}`;
      return { backend: createPiJudge({ runtime, model }), model, billing: "plan" };
    }
    if (spec?.provider === "anthropic") {
      const backend = anthropic();
      return backend
        ? { backend, model: config.model, billing: "api" }
        : { off: `safety.judge.model is ${config.model}, which needs an Anthropic API key` };
    }
    return {
      off: `safety.judge.model ${config.model} needs a ChatGPT plan login (or use an Anthropic model)`,
    };
  }

  const plan = planModel(runtime, plans, "judge");
  if (plan)
    return { backend: createPiJudge({ runtime, model: plan }), model: plan, billing: "plan" };

  const chosenApiModel = Boolean(opts.env.HAMNESS_MODEL?.trim() || configuredModel(opts.dataDir));
  const backend = chosenApiModel ? anthropic() : undefined;
  if (backend) return { backend, model: config.model, billing: "api" };
  return { off: "no ChatGPT plan login (hamness login openai)" };
}
