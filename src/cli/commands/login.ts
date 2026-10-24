import { login } from "../../agent/login.ts";
import { createRuntime } from "../../agent/models.ts";
import type { CliContext } from "../run.ts";

/** `hamness login <provider>`: sign in through Pi (ChatGPT plan: `hamness login openai`). */
export async function loginCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err("Usage: hamness login <provider>   (e.g. `hamness login openai` for a ChatGPT plan)");
    return 2;
  }
  return login({ provider, runtime: await createRuntime(dataDir), io, dataDir });
}

/** `hamness logout <provider>`: remove the login Pi stored for it. */
export async function logoutCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err("Usage: hamness logout <provider>");
    return 2;
  }
  const runtime = await createRuntime(dataDir);
  await runtime.logout(provider);
  io.out(`Signed out of ${provider}.`);
  return 0;
}
