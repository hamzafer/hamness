import {
  envKeyName,
  KeyFileError,
  keyFilePath,
  PROVIDER_ID,
  readKeyFile,
  removeKey,
  saveKey,
} from "../../agent/keys.ts";
import type { CliContext } from "../run.ts";

export const KEYS_USAGE = [
  "Usage: hamness keys <set|remove|list>",
  "  set <provider>     Store an API key (typed at a hidden prompt, or piped on stdin)",
  "  remove <provider>  Delete a provider's key from the key file",
  "  list               Show which providers have a key, and where it comes from",
  "API keys are optional and pay per token; the default is your ChatGPT plan (hamness login openai).",
  "An environment variable (e.g. ANTHROPIC_API_KEY) wins over the key file.",
].join("\n");

/** `hamness keys`: manage `<dataDir>/keys.json`. Keys are never printed. */
export async function keysCommand(ctx: CliContext): Promise<number> {
  const [sub, provider, extra] = ctx.args;
  try {
    if (sub === "set" && provider && extra === undefined) return await setKey(ctx, provider);
    if (sub === "remove" && provider && extra === undefined)
      return removeProviderKey(ctx, provider);
    if (sub === "list" && provider === undefined) return listKeys(ctx);
  } catch (err) {
    if (err instanceof KeyFileError) {
      ctx.io.err(`hamness keys: ${err.message}`);
      return 1;
    }
    throw err;
  }
  ctx.io.err(KEYS_USAGE);
  return 2;
}

async function setKey({ io, env, dataDir }: CliContext, provider: string): Promise<number> {
  if (!PROVIDER_ID.test(provider)) {
    io.err(`hamness keys: not a provider id: ${provider}`);
    return 2;
  }
  // Check the file before asking, so a bad mode fails fast and nothing is typed in vain.
  readKeyFile(dataDir);
  if (!io.readSecret) {
    io.err("hamness keys: no way to read a key here");
    return 1;
  }
  let key: string;
  try {
    key = await io.readSecret(`${provider} API key (input hidden): `);
  } catch {
    io.err("hamness keys: cancelled");
    return 1;
  }
  saveKey(dataDir, provider, key);
  io.out(`Saved the ${provider} key to ${keyFilePath(dataDir)} (mode 0600).`);
  const envName = envKeyName(provider, env);
  if (envName) io.out(`Note: ${envName} is set and wins over the key file.`);
  io.out("Restart the daemon (or start it) for running sessions to pick it up.");
  return 0;
}

function removeProviderKey({ io, env, dataDir }: CliContext, provider: string): number {
  if (!removeKey(dataDir, provider)) {
    io.err(`hamness keys: no ${provider} key in ${keyFilePath(dataDir)}`);
    return 1;
  }
  io.out(`Removed the ${provider} key from ${keyFilePath(dataDir)}.`);
  const envName = envKeyName(provider, env);
  if (envName)
    io.out(
      `Note: ${envName} is still set in your environment, so ${provider} API models still work.`,
    );
  io.out("Restart the daemon (`hamness stop`, then `hamness`) for running sessions to drop it.");
  return 0;
}

function listKeys({ io, env, dataDir }: CliContext): number {
  const fileProviders = Object.keys(readKeyFile(dataDir));
  const known = ["anthropic", "openai", "google", "openrouter", "xai", "mistral", "groq"];
  const rows: string[] = [];
  for (const provider of [...new Set([...known, ...fileProviders])].sort()) {
    const envName = envKeyName(provider, env);
    const inFile = fileProviders.includes(provider);
    if (!envName && !inFile) continue;
    const source = envName ? `env (${envName})${inFile ? ", key file too" : ""}` : `key file`;
    rows.push(`${provider.padEnd(12)} ${source}`);
  }
  if (rows.length === 0) io.out("No API keys yet. Add one with `hamness keys set <provider>`.");
  for (const row of rows) io.out(row);
  return 0;
}
