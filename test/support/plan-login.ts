import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A made-up JWT carrying the ChatGPT auth claim Pi's Codex login reads. Not a real token. */
export function fakeCodexToken(opts: { tier?: string; account?: boolean } = {}): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const auth: Record<string, string> = {};
  if (opts.account !== false) auth.chatgpt_account_id = "acct-test";
  if (opts.tier) auth.chatgpt_plan_type = opts.tier;
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": auth })}.sig`;
}

/**
 * A synthetic ChatGPT plan login in `<dataDir>/pi/auth.json`, as `hamness login openai` leaves
 * it (Pi's `openai-codex` provider). It expires far in the future, so nothing refreshes it.
 * `provider: "openai"` writes a login stored before ADR 0024 (Pi's Sign in with ChatGPT).
 */
export function writePlanLogin(
  dataDir: string,
  opts: { provider?: string; tier?: string; account?: boolean } = {},
): void {
  const dir = join(dataDir, "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const provider = opts.provider ?? "openai-codex";
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      [provider]: {
        type: "oauth",
        access: fakeCodexToken(opts),
        refresh: "fake-refresh-token",
        expires: Date.now() + 365 * 24 * 3600_000,
        ...(opts.account === false ? {} : { accountId: "acct-test" }),
      },
    }),
    { mode: 0o600 },
  );
}
