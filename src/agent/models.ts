import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Env } from "../config/paths.ts";

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

/** hamness's key file: `{ "<provider>": "<api key>" }`, readable by the owner only. */
export const keyFilePath = (dataDir: string) => join(dataDir, "keys.json");

function readKeyFile(path: string): Record<string, string> {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return {};
  }
  if (mode & 0o077) {
    throw new Error(`${path} must be readable by its owner only (chmod 0600)`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error(`${path} must be a JSON object`);
  return Object.fromEntries(
    Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * Builds Pi's model runtime from hamness's own dirs (never `~/.pi`), loads the API key
 * from the environment or the key file, and picks the model. Never reads the Keychain.
 */
export async function resolveModels(opts: { dataDir: string; env: Env }): Promise<ResolvedModels> {
  const piDir = join(opts.dataDir, "pi");
  const runtime = await ModelRuntime.create({
    authPath: join(piDir, "auth.json"),
    modelsPath: join(piDir, "models.json"),
    refreshOnCreate: false,
  });

  const spec = opts.env.HAMNESS_MODEL || DEFAULT_MODEL;
  const slash = spec.indexOf("/");
  const [provider, id] =
    slash > 0 ? [spec.slice(0, slash), spec.slice(slash + 1)] : ["anthropic", spec];
  const model = runtime.getModel(provider, id);
  if (!model) throw new Error(`unknown model ${provider}/${id}`);

  let keySource: ResolvedModels["keySource"] = "none";
  const fileKeys = readKeyFile(keyFilePath(opts.dataDir));
  const envKey = opts.env.ANTHROPIC_API_KEY;
  if (envKey) {
    await runtime.setRuntimeApiKey("anthropic", envKey);
    keySource = "env";
  } else if (fileKeys.anthropic) {
    await runtime.setRuntimeApiKey("anthropic", fileKeys.anthropic);
    keySource = "file";
  }
  for (const [p, key] of Object.entries(fileKeys)) {
    if (p !== "anthropic") await runtime.setRuntimeApiKey(p, key);
  }
  return { runtime, model, keySource };
}
