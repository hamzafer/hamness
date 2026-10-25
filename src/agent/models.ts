import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readJson } from "../config/json.ts";
import { type Env, userConfigFile } from "../config/paths.ts";
import { priceFor } from "../models/prices.ts";
import type { Billing } from "./billing.ts";
import { envKeyHint, envKeyName, readKeyFile } from "./keys.ts";
import { readPlanLogin } from "./plan.ts";

export { type Billing, billingLabel } from "./billing.ts";
export { keyFilePath } from "./keys.ts";

/** A model and the Pi runtime that can call it. Tests pass one built on a fake provider. */
export interface ModelChoice {
  runtime: ModelRuntime;
  model: Model<Api>;
  /** How each provider is billed; undefined for one with no credential (tests leave it out). */
  billing?: (provider: string) => Billing | undefined;
  /** The ChatGPT plan tier from the login (`go`, `plus`, ...), when known. */
  planTier?: string;
}

/** Where the default model came from; `none`: nothing is set up. */
export type ModelOrigin = "env" | "config" | "plan" | "none";

export interface ResolvedModels extends ModelChoice {
  /** Where the Anthropic key came from. `none` means Anthropic calls fail until one is set. */
  keySource: "env" | "file" | "none";
  /** Why this model is the default: `HAMNESS_MODEL`, the user config, or the ChatGPT plan. */
  origin: Exclude<ModelOrigin, "none">;
  billing: (provider: string) => Billing | undefined;
}

/** Pi's ChatGPT-plan provider: the Codex backend, OAuth only, so no API key can reach it. */
export const PLAN_PROVIDER = "openai-codex";
/** The main agent's and subagents' default on the ChatGPT plan (ADR 0024). */
export const PLAN_DEFAULT_MODEL = "openai-codex/gpt-5.6-terra";
/** The judge's default on the ChatGPT plan: cheap and fast (ADR 0024). */
export const PLAN_JUDGE_MODEL = "openai-codex/gpt-5.6-luna";

/**
 * Plan models to try, best first, per subscription provider. `openai` is Pi's newer
 * "Sign in with ChatGPT" login (also billed to the plan), kept for logins stored before ADR 0024.
 */
const PLAN_PREFERENCE: Readonly<Record<string, { main: string[]; judge: string[] }>> = {
  "openai-codex": { main: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"], judge: ["gpt-5.6-luna"] },
  openai: { main: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"], judge: ["gpt-5.6-luna"] },
};

/**
 * The Codex models a ChatGPT tier may use, for the tiers known to be limited. Pi's catalog has
 * no flag for it, and the Codex backend refuses the rest ("not supported when using Codex with
 * a ChatGPT account"). Observed live, not documented (ADR 0024): on Go only gpt-5.6-terra
 * answered (gpt-5.6-sol and gpt-5.5 stayed silent, gpt-6.1-sol was refused). Tiers not listed
 * get the whole catalog.
 */
export const PLAN_TIER_SUPPORTED: Readonly<Record<string, readonly string[]>> = {
  free: ["gpt-5.6-terra", "gpt-5.6-luna"],
  go: ["gpt-5.6-terra", "gpt-5.6-luna"],
};

/**
 * The main model per ChatGPT plan tier (the `chatgpt_plan_type` in the Codex login's token).
 * Best-effort (ADR 0024): Go and Team/Business were checked live (Team/Business: gpt-6.1-sol,
 * gpt-6-sol, gpt-5.6-sol and gpt-5.6-terra all answer); Plus and Pro are assumed to match
 * Team. A tier not listed, or no tier in the token, gets `PLAN_DEFAULT_MODEL`.
 */
export const PLAN_TIER_MODEL: Readonly<Record<string, string>> = {
  free: "gpt-5.6-terra",
  go: "gpt-5.6-terra",
  plus: "gpt-6.1-sol",
  pro: "gpt-6.1-sol",
  team: "gpt-6.1-sol",
  business: "gpt-6.1-sol",
  enterprise: "gpt-6.1-sol",
  edu: "gpt-6.1-sol",
};

/** False for a Codex model the ChatGPT plan tier is known not to serve. */
export function planSupports(provider: string, id: string, tier?: string): boolean {
  if (provider !== PLAN_PROVIDER || !tier) return true;
  const list = PLAN_TIER_SUPPORTED[tier];
  return !list || list.includes(id);
}

/** The Codex backend's refusal of a model a ChatGPT account can't use. */
export const PLAN_UNSUPPORTED_ERROR = /not supported when using Codex with a ChatGPT account/i;

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

/** The part of Pi's runtime that says which logins are stored. Tests pass a fake. */
type LoginRuntime = Pick<ModelRuntime, "listCredentials" | "getProvider">;

/**
 * Providers with a stored subscription login (a ChatGPT plan): their calls are billed to the
 * plan. Anthropic never counts (ADR 0011). Read before any runtime key is set, which would hide it.
 */
export async function planProviders(runtime: LoginRuntime): Promise<string[]> {
  const stored = await runtime.listCredentials();
  return stored
    .filter(
      (c) =>
        c.type === "oauth" &&
        c.providerId !== "anthropic" &&
        runtime.getProvider(c.providerId)?.auth.oauth?.isSubscription === true,
    )
    .map((c) => c.providerId)
    .sort((a, b) => (a === PLAN_PROVIDER ? -1 : b === PLAN_PROVIDER ? 1 : a.localeCompare(b)));
}

/** The user config's `defaultModel` (`<dataDir>/config.json`), if set. */
export function configuredModel(dataDir: string): string | undefined {
  const path = userConfigFile(dataDir);
  const value = readJson(path)?.defaultModel;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !parseModelSpec(value)) {
    throw new Error(`${path}: defaultModel must be "provider/id"`);
  }
  return value.trim();
}

/**
 * The ChatGPT plan models to try for `role`, best first: the tier's (main only), then the
 * preference list. Only ChatGPT plan providers (`PLAN_PREFERENCE`): another subscription
 * (Copilot, xAI, ...) is never picked on its own.
 */
export function planCandidates(
  runtime: Pick<ModelRuntime, "getModel">,
  plans: readonly string[],
  role: "main" | "judge",
  tier?: string,
): string[] {
  const out: string[] = [];
  for (const provider of plans) {
    const prefs = PLAN_PREFERENCE[provider];
    if (!prefs) continue;
    const byTier =
      role === "main" && provider === PLAN_PROVIDER && tier ? PLAN_TIER_MODEL[tier] : undefined;
    for (const id of [...(byTier ? [byTier] : []), ...prefs[role]]) {
      const spec = `${provider}/${id}`;
      if (runtime.getModel(provider, id) && !out.includes(spec)) out.push(spec);
    }
  }
  return out;
}

/** The first plan model for `role` that is not in `refused` (models the plan turned down). */
export function planModel(
  runtime: Pick<ModelRuntime, "getModel">,
  plans: readonly string[],
  role: "main" | "judge",
  tier?: string,
  refused?: ReadonlySet<string>,
): string | undefined {
  return planCandidates(runtime, plans, role, tier).find((m) => !refused?.has(m));
}

/**
 * The default model, in order (ADR 0024): `HAMNESS_MODEL`, the user config's `defaultModel`,
 * then the ChatGPT plan's best model. An API key alone never makes a model the default, so a
 * stray `OPENAI_API_KEY` can't start a bill.
 */
export function pickDefaultModel(opts: {
  env: Env;
  configModel: string | undefined;
  plans: readonly string[];
  runtime: Pick<ModelRuntime, "getModel">;
  /** The ChatGPT plan tier, when the login says. */
  tier?: string | undefined;
}): { spec?: string; origin: ModelOrigin } {
  const fromEnv = opts.env.HAMNESS_MODEL?.trim();
  if (fromEnv) return { spec: fromEnv, origin: "env" };
  if (opts.configModel) return { spec: opts.configModel, origin: "config" };
  const plan = planModel(opts.runtime, opts.plans, "main", opts.tier);
  return plan ? { spec: plan, origin: "plan" } : { origin: "none" };
}

/** `plan` for a ChatGPT plan provider, `subscription` for any other subscription login. */
const subscriptionKind = (provider: string): Billing =>
  PLAN_PREFERENCE[provider] ? { kind: "plan" } : { kind: "subscription" };

/** How `provider` is billed, given the subscription logins, the env and the key file. */
export function billingOf(
  provider: string,
  ctx: { plans: readonly string[]; env: Env; fileKeys: Record<string, string>; stored?: string[] },
): Billing | undefined {
  if (ctx.plans.includes(provider)) return subscriptionKind(provider);
  const envName = envKeyName(provider, ctx.env);
  if (envName) return { kind: "api", source: envName };
  if (ctx.fileKeys[provider]) return { kind: "api", source: "key file" };
  if (ctx.stored?.includes(provider)) return { kind: "api", source: "stored key" };
  return undefined;
}

/**
 * How `provider` is billed right now, from Pi's own auth state: a subscription login in use, or
 * the API key it resolves (and from where). `fallback` answers before Pi has checked a provider.
 * `keyed` answers when Pi sees no credential: Pi reads the process env, but hamness passes its
 * own `env`, so an API key there still bills. Undefined when the provider has no credential.
 */
export function liveBilling(
  runtime: Pick<ModelRuntime, "isUsingSubscription" | "getProviderAuthStatus" | "isUsingOAuth">,
  provider: string,
  env: Env,
  fallback: (provider: string) => Billing | undefined = () => undefined,
  keyed: (provider: string) => Billing | undefined = () => undefined,
): Billing | undefined {
  if (runtime.isUsingSubscription(provider)) return subscriptionKind(provider);
  const status = runtime.getProviderAuthStatus(provider);
  if (!status.configured) return keyed(provider);
  if (runtime.isUsingOAuth(provider)) return fallback(provider);
  if (status.source === "stored") return fallback(provider);
  const source =
    envKeyName(provider, env) ??
    (status.source === "runtime"
      ? "key file"
      : status.source === "environment"
        ? status.label
        : undefined);
  return { kind: "api", ...(source ? { source } : {}) };
}

/**
 * Hands Pi the API keys: for each provider, its env var if set, else the key file's entry.
 * Plan providers are skipped: a runtime key would override the plan login and bill per token.
 * Returns where the Anthropic key came from.
 */
async function loadKeys(
  runtime: ModelRuntime,
  dataDir: string,
  env: Env,
  plans: readonly string[],
): Promise<ResolvedModels["keySource"]> {
  const fileKeys = readKeyFile(dataDir);
  let anthropic: ResolvedModels["keySource"] = "none";
  const providers = new Set(["anthropic", ...Object.keys(fileKeys)]);
  for (const provider of providers) {
    if (plans.includes(provider)) continue;
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

/** Not set up: no ChatGPT plan login and no chosen model. */
export class NotSetUpError extends Error {
  constructor() {
    super(
      "no model is set up: sign in with your ChatGPT plan (`hamness login openai`), or choose an API model with HAMNESS_MODEL or defaultModel",
    );
    this.name = "NotSetUpError";
  }
}

/** The runtime with keys loaded, the default model (if any) and how each provider is billed. */
export async function loadModels(opts: { dataDir: string; env: Env }): Promise<{
  runtime: ModelRuntime;
  model?: Model<Api>;
  origin: ModelOrigin;
  keySource: ResolvedModels["keySource"];
  billing: (provider: string) => Billing | undefined;
  planTier?: string;
}> {
  const runtime = await createRuntime(opts.dataDir);
  const plans = await planProviders(runtime);
  const planTier = plans.includes(PLAN_PROVIDER) ? readPlanLogin(opts.dataDir)?.tier : undefined;
  const stored = (await runtime.listCredentials())
    .filter((c) => c.type === "api_key")
    .map((c) => c.providerId);
  const { spec, origin } = pickDefaultModel({
    env: opts.env,
    configModel: configuredModel(opts.dataDir),
    tier: planTier,
    plans,
    runtime,
  });
  let model: Model<Api> | undefined;
  if (spec) {
    const parsed = parseModelSpec(spec);
    if (!parsed) throw new Error("HAMNESS_MODEL is empty");
    model = runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error(`unknown model ${parsed.provider}/${parsed.id}`);
  }
  const keySource = await loadKeys(runtime, opts.dataDir, opts.env, plans);
  await refuseClaudeSubscription(runtime, opts.env, keySource);
  const fileKeys = readKeyFile(opts.dataDir);
  // Fills Pi's auth snapshot, which `liveBilling` reads; a provider that fails is just unavailable.
  await runtime.getAvailable().catch(() => []);
  const fallback = (provider: string) =>
    billingOf(provider, { plans, env: opts.env, fileKeys, stored });
  // Keys only, no plan logins: a plan Pi no longer sees (signed out) must not count as billed.
  const keyed = (provider: string) =>
    billingOf(provider, { plans: [], env: opts.env, fileKeys, stored });
  const billing = (provider: string) => liveBilling(runtime, provider, opts.env, fallback, keyed);
  return {
    runtime,
    ...(model ? { model } : {}),
    origin,
    keySource,
    billing,
    ...(planTier ? { planTier } : {}),
  };
}

/**
 * Builds Pi's model runtime from hamness's own dirs, loads API keys from the environment or
 * the key file, and picks the model (`pickDefaultModel`). Throws `NotSetUpError` when there is
 * none. Never reads the Keychain.
 */
export async function resolveModels(opts: { dataDir: string; env: Env }): Promise<ResolvedModels> {
  const loaded = await loadModels(opts);
  if (!loaded.model || loaded.origin === "none") throw new NotSetUpError();
  return { ...loaded, model: loaded.model, origin: loaded.origin };
}

/** One row of the model picker and `hamness models`. */
export interface ModelInfo {
  /** `provider/id`. */
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  /** API prices; a plan model's calls cost $0 (see `billing`). */
  inputPerMTok: number;
  outputPerMTok: number;
  /** True when the price is from hamness's checked table, false when it is Pi's catalog. */
  priced: boolean;
  /** How calls to it are paid for. Absent when unknown (no credential, or a test runtime). */
  billing?: Billing;
}

export function modelInfo(model: Model<Api>, billing?: Billing): ModelInfo {
  const price = priceFor(model.id);
  return {
    id: modelName(model),
    provider: model.provider,
    name: model.name,
    contextWindow: model.contextWindow,
    inputPerMTok: price?.input ?? model.cost.input,
    outputPerMTok: price?.output ?? model.cost.output,
    priced: price !== undefined,
    ...(billing ? { billing } : {}),
  };
}

/** Plan models first (the preferred one on top), then API models by provider and id. */
const byBilling =
  (tier?: string) =>
  (a: ModelInfo, b: ModelInfo): number => {
    const plan = (m: ModelInfo) => (m.billing?.kind === "plan" ? 0 : 1);
    const first = tier ? PLAN_TIER_MODEL[tier] : undefined;
    const rank = (m: ModelInfo) => {
      const preferred = PLAN_PREFERENCE[m.provider]?.main ?? [];
      const order = first && m.provider === PLAN_PROVIDER ? [first, ...preferred] : preferred;
      const i = order.indexOf(m.id.slice(m.provider.length + 1));
      return i < 0 ? order.length : i;
    };
    return (
      plan(a) - plan(b) ||
      (a.provider === PLAN_PROVIDER ? 0 : 1) - (b.provider === PLAN_PROVIDER ? 0 : 1) ||
      a.provider.localeCompare(b.provider) ||
      (plan(a) === 0 ? rank(a) - rank(b) : 0) ||
      a.id.localeCompare(b.id)
    );
  };

/**
 * The models Pi's catalog offers for providers that have credentials (a key from env or the
 * key file, or a login), plan models first. Anthropic models need an API key.
 */
export async function listModels(
  runtime: ModelRuntime,
  billing?: (provider: string) => Billing | undefined,
  tier?: string,
): Promise<ModelInfo[]> {
  const available = await runtime.getAvailable();
  return (
    available
      .map((m) => modelInfo(m, billing?.(m.provider)))
      // Models the ChatGPT plan refuses are left out (`hamness models --all` lists them).
      .filter(
        (m) =>
          m.billing?.kind !== "plan" ||
          planSupports(m.provider, m.id.slice(m.provider.length + 1), tier),
      )
      .sort(byBilling(tier))
  );
}

/** The model new sessions use, and how it is paid for. Names an env var, never its value. */
export interface ModelCredential {
  /** `provider/id` of the model new sessions use; undefined when nothing is set up. */
  model?: string;
  provider?: string;
  origin: ModelOrigin;
  /** How it is billed; undefined when its provider has no key or login. */
  billing?: Billing;
  /** The env var a user would set for this provider's API key. */
  envHint?: string;
  /** A stored `openai` ChatGPT login from before ADR 0024 (Pi's newer Sign in with ChatGPT). */
  legacyOpenaiLogin: boolean;
}

/**
 * Which model new sessions use and how it is billed. Reads only `env` and hamness's own files
 * (never the Keychain), so setup and `hamness doctor` can say what to do.
 */
export async function defaultModelCredential(opts: {
  dataDir: string;
  env: Env;
}): Promise<ModelCredential> {
  const runtime = await createRuntime(opts.dataDir);
  const plans = await planProviders(runtime);
  const stored = (await runtime.listCredentials())
    .filter((c) => c.type === "api_key")
    .map((c) => c.providerId);
  const { spec, origin } = pickDefaultModel({
    env: opts.env,
    configModel: configuredModel(opts.dataDir),
    tier: readPlanLogin(opts.dataDir)?.tier,
    plans,
    runtime,
  });
  const legacyOpenaiLogin = plans.includes("openai") && !plans.includes(PLAN_PROVIDER);
  const parsed = spec ? parseModelSpec(spec) : undefined;
  if (!parsed) return { origin: "none", legacyOpenaiLogin };
  const billing = billingOf(parsed.provider, {
    plans,
    env: opts.env,
    fileKeys: readKeyFile(opts.dataDir),
    stored,
  });
  return {
    model: `${parsed.provider}/${parsed.id}`,
    provider: parsed.provider,
    origin,
    ...(billing ? { billing } : {}),
    envHint: envKeyHint(parsed.provider),
    legacyOpenaiLogin,
  };
}
