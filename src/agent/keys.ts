import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { writeJsonAtomic } from "../config/json.ts";
import { type Env, ensureDataDir } from "../config/paths.ts";

/**
 * hamness's key file: `{ "<provider>": "<api key>" }` in `<dataDir>/keys.json`, mode 0600.
 * Keys never go to logs, events or output; callers print provider names only.
 */
export const keyFilePath = (dataDir: string) => join(dataDir, "keys.json");

/** Provider ids as Pi names them (`anthropic`, `openai`, `google-vertex`). */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Env vars hamness never takes a key from. `ANTHROPIC_OAUTH_TOKEN` carries a Claude
 * subscription token, which hamness does not use (see ADR 0011).
 */
const IGNORED_ENV = new Set(["ANTHROPIC_OAUTH_TOKEN"]);

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFileError";
  }
}

function checkMode(path: string): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return false;
  }
  if (mode & 0o077) {
    throw new KeyFileError(`${path} must be readable by its owner only (chmod 0600)`);
  }
  return true;
}

/** The stored keys. Empty when there is no file; throws when the file's mode lets others read it. */
export function readKeyFile(dataDir: string): Record<string, string> {
  const path = keyFilePath(dataDir);
  if (!checkMode(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new KeyFileError(`${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KeyFileError(`${path} must be a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/** Stores (or replaces) one provider's key. Writes a 0600 temp file and renames it into place. */
export function saveKey(dataDir: string, provider: string, key: string): void {
  if (!PROVIDER_ID.test(provider)) throw new KeyFileError(`not a provider id: ${provider}`);
  const value = key.trim();
  if (!value) throw new KeyFileError("the key is empty");
  ensureDataDir(dataDir);
  const keys = readKeyFile(dataDir);
  keys[provider] = value;
  writeJsonAtomic(keyFilePath(dataDir), keys, 0o600);
}

/** The env var that holds a key for `provider` in `env`, if one is set. Never returns the value. */
export function envKeyName(provider: string, env: Env): string | undefined {
  // Pi falls back to `process.env`; only names set in `env` itself count.
  const names = [
    ...(findEnvKeys(provider, env as Record<string, string>) ?? []),
    envKeyHint(provider),
  ];
  return names.find((name) => !IGNORED_ENV.has(name) && Boolean(env[name]));
}

const KNOWN_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

/** The env var a user would set for `provider` (for messages). */
export function envKeyHint(provider: string): string {
  return KNOWN_ENV[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
