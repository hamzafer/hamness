import { join } from "node:path";
import { readJsonOr } from "../config/json.ts";

/** Where Pi's Codex login keeps the ChatGPT account facts in its access token (a JWT). */
const AUTH_CLAIM = "https://api.openai.com/auth";

/** What hamness reads from the stored ChatGPT plan login. Never the token itself. */
export interface PlanLogin {
  /** The plan tier (`go`, `plus`, `pro`, `team`, ...), lower case; undefined when the token has none. */
  tier?: string;
  /** False when the token lacks `chatgpt_account_id`: Pi's Codex calls fail, so sign in again. */
  hasAccount: boolean;
}

function claims(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const auth = json?.[AUTH_CLAIM];
    return auth && typeof auth === "object" ? (auth as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored `openai-codex` login's plan facts, decoded locally from `<dataDir>/pi/auth.json`
 * (hamness's own file, never `~/.pi` or the Keychain). Undefined with no such login.
 */
export function readPlanLogin(dataDir: string): PlanLogin | undefined {
  const auth = readJsonOr(join(dataDir, "pi", "auth.json"));
  const cred = auth?.["openai-codex"] as Record<string, unknown> | undefined;
  if (cred?.type !== "oauth" || typeof cred.access !== "string") return undefined;
  const c = claims(cred.access);
  const tier =
    typeof c?.chatgpt_plan_type === "string" ? c.chatgpt_plan_type.toLowerCase() : undefined;
  const account = c?.chatgpt_account_id ?? cred.accountId;
  return {
    ...(tier ? { tier } : {}),
    hasAccount: typeof account === "string" && account.length > 0,
  };
}

/** `Go`, `Plus`, `Pro`: a tier for messages. */
export const tierLabel = (tier: string | undefined) =>
  tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "unknown tier";
