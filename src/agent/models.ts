import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Env } from "../config/paths.ts";
import { priceFor } from "../models/prices.ts";
import { envKeyName, readKeyFile } from "./keys.ts";

export { keyFilePath } from "./keys.ts";

/** A model and the Pi runtime that can call it. Tests pass one built on a fake provider. */
export interface ModelChoice {
  runtime: ModelRuntime;
  model: Model<Api>;
}

export interface ResolvedModels extends ModelChoice {
  /** Where the Anthropic key came from. `none` means calls fail until one is set. */
  keySource: "env" | "file" | "none";
}

/** The default model: Claude, through an API key (spec section 5). `HAMNESS_MODEL` overrides it. */
export const DEFAULT_MODEL = "anthropic/claude-opus-5-5";

/** `provider/id` (the id may contain more slashes); a bare id means Anthropic. */
export function parseModelSpec(spec: string): { provider: string; id: string } | undefined {
  const s = spec.trim();
  if (!s) return undefined;
  const slash = s.indexOf("/");
  if (slash < 0) return { provider: "anthropic", id: s };
  const provider = s.slice(0, slash);
  const id = s.slice(slash + 1);
  return provider && id ? { provider, id } : undefined;
}

export const modelName = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** Pi's `<dataDir>/pi` runtime: hamness's own auth.json and models.json, never `~/.pi`. */
export function createRuntime(dataDir: string): Promise<ModelRuntime> {
  const piDir = join(dataDir, "pi");
  return ModelRuntime.create({
    authPath: join(piDir, "auth.json"),
    modelsPath: join(piDir, "models.json"),
    refreshOnCreate: false,
  });
}

/**
 * Hands Pi the API keys: for each provider, its env var if set, else the key file's entry.
 * Returns where the Anthropic key came from.
 */
async function loadKeys(
  runtime: ModelRuntime,
  dataDir: string,
  env: Env,
): Promise<ResolvedModels["keySource"]> {
  const fileKeys = readKeyFile(dataDir);
  let anthropic: ResolvedModels["keySource"] = "none";
  const providers = new Set(["anthropic", ...Object.keys(fileKeys)]);
  for (const provider of providers) {
    const envName = envKeyName(provider, env);
    const key = envName ? env[envName] : fileKeys[provider];
    if (!key) continue;
    await runtime.setRuntimeApiKey(provider, key);
    if (provider === "anthropic") anthropic = envName ? "env" : "file";
  }
  return anthropic;
}

/**
 * Claude subscriptions are for Claude Code, not third-party harnesses (ADR 0011), so hamness
 * calls Anthropic with an API key only: no Pi OAuth login and no `ANTHROPIC_OAUTH_TOKEN`.
 */
async function refuseClaudeSubscription(
  runtime: ModelRuntime,
  env: Env,
  keySource: ResolvedModels["keySource"],
): Promise<void> {
  const fix = "Set ANTHROPIC_API_KEY or run `hamness keys set anthropic`.";
  const stored = await runtime.listCredentials();
  if (stored.some((c) => c.providerId === "anthropic" && c.type === "oauth")) {
    throw new Error(
      `hamness does not use Claude subscription logins. Run \`hamness logout anthropic\`, then ${fix}`,
    );
  }
  if (keySource === "none" && env.ANTHROPIC_OAUTH_TOKEN) {
    throw new Error(
      `hamness does not use Claude subscription tokens (ANTHROPIC_OAUTH_TOKEN). ${fix}`,
    );
  }
}

/**
 * Builds Pi's model runtime from hamness's own dirs, loads API keys from the environment or
 * the key file, and picks the model. Never reads the Keychain.
 */
export async function resolveModels(opts: { dataDir: string; env: Env }): Promise<ResolvedModels> {
  const runtime = await createRuntime(opts.dataDir);
  const spec = parseModelSpec(opts.env.HAMNESS_MODEL || DEFAULT_MODEL);
  if (!spec) throw new Error("HAMNESS_MODEL is empty");
  const model = runtime.getModel(spec.provider, spec.id);
  if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);

  const keySource = await loadKeys(runtime, opts.dataDir, opts.env);
  await refuseClaudeSubscription(runtime, opts.env, keySource);
  return { runtime, model, keySource };
}

/** One row of the model picker and `hamness models`. */
export interface ModelInfo {
  /** `provider/id`. */
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  inputPerMTok: number;
  outputPerMTok: number;
  /** True when the price is from hamness's checked table, false when it is Pi's catalog. */
  priced: boolean;
}

export function modelInfo(model: Model<Api>): ModelInfo {
  const price = priceFor(model.id);
  return {
    id: modelName(model),
    provider: model.provider,
    name: model.name,
    contextWindow: model.contextWindow,
    inputPerMTok: price?.input ?? model.cost.input,
    outputPerMTok: price?.output ?? model.cost.output,
    priced: price !== undefined,
  };
}

/**
 * The models Pi's catalog offers for providers that have credentials (a key from env or the
 * key file, or a login). Anthropic models need an API key (see `refuseClaudeSubscription`).
 */
export async function listModels(runtime: ModelRuntime): Promise<ModelInfo[]> {
  const available = await runtime.getAvailable();
  return available
    .map(modelInfo)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}
