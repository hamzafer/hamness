import { login } from "../../agent/login.ts";
import { createRuntime } from "../../agent/models.ts";
import type { CliContext } from "../run.ts";

export const LOGIN_USAGE = [
  "Usage: hamness login <provider>",
  "",
  "Signs in through Pi and stores the login in hamness's data dir.",
  "`hamness login openai` signs in with a ChatGPT plan. Anthropic is API key only:",
  "use `hamness keys set anthropic` or ANTHROPIC_API_KEY.",
].join("\n");

export const LOGOUT_USAGE = [
  "Usage: hamness logout <provider>",
  "",
  "Removes the login `hamness login <provider>` stored.",
].join("\n");

/** `hamness login <provider>`: sign in through Pi (ChatGPT plan: `hamness login openai`). */
export async function loginCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err(LOGIN_USAGE);
    return 2;
  }
  return login({ provider, runtime: await createRuntime(dataDir), io, dataDir });
}

/** `hamness logout <provider>`: remove the login Pi stored for it. */
export async function logoutCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err(LOGOUT_USAGE);
    return 2;
  }
  const runtime = await createRuntime(dataDir);
  await runtime.logout(provider);
  io.out(`Signed out of ${provider}.`);
  return 0;
}
