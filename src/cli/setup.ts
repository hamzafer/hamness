import { keyFilePath } from "../agent/keys.ts";
import type { ModelCredential } from "../agent/models.ts";
import type { SafetyMode } from "../events/types.ts";
import { userConfigPath } from "../safety/config.ts";

/** One line on what a safety mode does, for setup and `hamness doctor`. */
export function modeSummary(mode: SafetyMode, judgeOn: boolean): string {
  if (mode === "ask") return "ask: you decide every tool call no rule decides";
  if (mode === "yolo") return "yolo: every tool call is allowed (a red banner says so)";
  return judgeOn
    ? "auto: the judge model decides calls no rule decides, and asks you when unsure"
    : "auto: the judge is off (no Anthropic key), so calls no rule decides ask you";
}

/** How to give a provider a key: the two ways, plus a login where Pi has one. */
export function keyHowTo(cred: ModelCredential, dataDir: string): string[] {
  const lines = [
    `  hamness keys set ${cred.provider}    (hidden prompt; saved to ${keyFilePath(dataDir)}, mode 0600)`,
    `  export ${cred.envHint}=...    (an env var wins over the key file)`,
  ];
  if (cred.provider === "openai") lines.push("  hamness login openai    (a ChatGPT plan)");
  return lines;
}

/** What `hamness` prints instead of the chat when the default model has no key yet. */
export function firstRunSetup(opts: {
  cred: ModelCredential;
  dataDir: string;
  mode: SafetyMode;
}): string[] {
  const { cred, dataDir, mode } = opts;
  return [
    "Welcome to hamness.",
    "",
    `Chat uses ${cred.model}, which needs an API key first. Either:`,
    ...keyHowTo(cred, dataDir),
    ...(cred.provider === "anthropic"
      ? ["Claude subscriptions are not used: Anthropic is API key only."]
      : []),
    "Another model: HAMNESS_MODEL=provider/id (see `hamness models --all`).",
    "",
    `Safety mode is ${modeSummary(mode, cred.provider === "anthropic" && cred.source !== "none")}.`,
    `Set "safety": { "mode": "ask" | "auto" | "yolo" } in ${userConfigPath(dataDir)} to change it.`,
    "",
    "Then run `hamness` again. `hamness doctor` checks the whole setup.",
  ];
}
