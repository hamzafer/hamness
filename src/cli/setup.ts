import { keyFilePath } from "../agent/keys.ts";
import type { ModelCredential } from "../agent/models.ts";
import type { SafetyMode } from "../events/types.ts";
import { userConfigPath } from "../safety/config.ts";

/** One line on what a safety mode does, for setup and `hamness doctor`. */
export function modeSummary(mode: SafetyMode, judgeOn: boolean): string {
  if (mode === "ask") return "ask: you decide every tool call no rule decides";
  if (mode === "yolo")
    return "yolo: every tool call no deny rule stops is allowed, with no question (a red banner says so)";
  return judgeOn
    ? "auto: the judge model decides calls no rule decides, and asks you when unsure"
    : "auto: the judge is off (no ChatGPT plan login or judge key), so calls no rule decides ask you";
}

/** The way to start: the ChatGPT plan. */
export const SIGN_IN = "Sign in with your ChatGPT plan: hamness login openai";

/** The optional extra: pay-per-token API keys. */
export const API_KEYS_OPTIONAL =
  "optional: hamness keys set anthropic|openai to use pay-per-token API models";

/** How to give an API model's provider a key (the user chose that model). */
export function keyHowTo(cred: ModelCredential, dataDir: string): string[] {
  const provider = cred.provider ?? "<provider>";
  return [
    `  hamness keys set ${provider}    (hidden prompt; saved to ${keyFilePath(dataDir)}, mode 0600)`,
    `  export ${cred.envHint ?? "<PROVIDER>_API_KEY"}=...    (an env var wins over the key file)`,
  ];
}

/** What to do when nothing is set up, or the chosen model has no key: plan first, keys optional. */
export function setupSteps(cred: ModelCredential, dataDir: string): string[] {
  if (cred.origin === "none" || cred.origin === "plan") {
    return [`  ${SIGN_IN}`, `  ${API_KEYS_OPTIONAL}`];
  }
  const from =
    cred.origin === "env" ? "HAMNESS_MODEL" : `defaultModel in ${userConfigPath(dataDir)}`;
  return [
    `  ${cred.model} (set by ${from}) is an API model and needs a key:`,
    ...keyHowTo(cred, dataDir),
    `  or unset ${cred.origin === "env" ? "HAMNESS_MODEL" : "defaultModel"} and ${SIGN_IN.toLowerCase()}`,
  ];
}

/** What `hamness` prints instead of the chat when no model is ready yet. */
export function firstRunSetup(opts: {
  cred: ModelCredential;
  dataDir: string;
  mode: SafetyMode;
}): string[] {
  const { cred, dataDir, mode } = opts;
  return [
    "Welcome to hamness.",
    "",
    "Chat needs a model first.",
    ...setupSteps(cred, dataDir),
    "Claude subscriptions are not used: Claude is reached with an optional API key only.",
    "",
    `Safety mode is ${modeSummary(mode, false)}.`,
    `Set "safety": { "mode": "ask" | "auto" | "yolo" } in ${userConfigPath(dataDir)} to change it.`,
    "",
    "Then run `hamness` again. `hamness doctor` checks the whole setup.",
  ];
}
