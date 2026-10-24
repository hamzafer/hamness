/**
 * Auto mode's judge (ADR 0006): a small model decides calls no rule decides. `anthropic.ts`
 * makes the model call, `controller.ts` adds the deadline, budget and back-off.
 */

import { envKeyName, readKeyFile } from "../../agent/keys.ts";
import type { Env } from "../../config/paths.ts";
import { anthropicClient, type BackendJudge, createAnthropicJudge } from "./anthropic.ts";

export type { BackendJudge, JudgeCallOptions } from "./anthropic.ts";
export { createAnthropicJudge, DEFAULT_JUDGE_MODEL, parseVerdict } from "./anthropic.ts";
export { JUDGE_CATEGORIES, type JudgeCategory } from "./categories.ts";
export { BACK_OFF, BUDGET_REACHED, createJudgeController } from "./controller.ts";

/**
 * The Anthropic judge, keyed like sessions are: `ANTHROPIC_API_KEY`, else the key file.
 * Undefined with no key (the judge is then off). Never reads the Keychain.
 */
export function judgeFromKeys(opts: { dataDir: string; env: Env }): BackendJudge | undefined {
  const envName = envKeyName("anthropic", opts.env);
  const key = envName ? opts.env[envName] : readKeyFile(opts.dataDir).anthropic;
  return key ? createAnthropicJudge({ client: anthropicClient(key) }) : undefined;
}
