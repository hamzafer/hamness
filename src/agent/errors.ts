import { envKeyHint, keyFilePath } from "./keys.ts";

const NETWORK =
  /connection error|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed out/i;
const REFUSED_KEY =
  /\b401\b|authentication_error|invalid x-api-key|invalid api key|incorrect api key/i;

/**
 * Pi's model errors, made actionable: a missing key points at hamness's key commands (not
 * Pi's `/login`), a refused key says to replace it, a network failure says to retry.
 * Anything else passes through unchanged.
 */
export function explainModelError(message: string, dataDir: string, provider?: string): string {
  const missing = /No API key (?:found )?for ([\w-]+)/.exec(message);
  if (missing) {
    const p = missing[1] ?? "anthropic";
    return `No API key for ${p}. Set ${envKeyHint(p)}, or run \`hamness keys set ${p}\` (stored in ${keyFilePath(dataDir)}, mode 0600), then restart the daemon with \`hamness stop\` and \`hamness\`.`;
  }
  const who = provider ?? "the model provider";
  if (REFUSED_KEY.test(message)) {
    const set = provider
      ? `\`hamness keys set ${provider}\` (or ${envKeyHint(provider)})`
      : "`hamness keys set <provider>`";
    return `The ${provider ?? "provider's"} API key was refused (${message.slice(0, 120)}). Set a new one with ${set}, then \`hamness stop\` and run \`hamness\` again.`;
  }
  if (NETWORK.test(message)) {
    return `Could not reach ${who}: ${message}. Check your network connection, then send the prompt again.`;
  }
  return message;
}
