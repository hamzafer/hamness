import { login, loginProvider } from "../../agent/login.ts";
import { createRuntime, planModel } from "../../agent/models.ts";
import { readPlanLogin } from "../../agent/plan.ts";
import type { CliContext } from "../run.ts";

export const LOGIN_USAGE = [
  "Usage: hamness login <provider>",
  "",
  "Signs in through Pi and stores the login in hamness's data dir.",
  "`hamness login openai` signs in with your ChatGPT plan (Pi's openai-codex provider);",
  "its models are then the default, billed to the plan. Anthropic is API key only:",
  "use `hamness keys set anthropic` or ANTHROPIC_API_KEY.",
].join("\n");

export const LOGOUT_USAGE = [
  "Usage: hamness logout <provider>",
  "",
  "Removes the login `hamness login <provider>` stored.",
  "`hamness logout openai` removes the ChatGPT plan login and an older OpenAI sign-in;",
  "`hamness logout openai-api` removes only the older one (Pi's Sign in with ChatGPT for",
  "api.openai.com), keeping the plan login.",
].join("\n");

/** `hamness logout openai-api`: only Pi's `openai` OAuth login (ADR 0024), never `openai-codex`. */
const OLDER_OPENAI_LOGOUT = "openai-api";

/** `hamness login <provider>`: sign in through Pi (ChatGPT plan: `hamness login openai`). */
export async function loginCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err(LOGIN_USAGE);
    return 2;
  }
  const runtime = await createRuntime(dataDir);
  return login({
    provider,
    runtime,
    io,
    dataDir,
    planModel: (p) => planModel(runtime, [p], "main", readPlanLogin(dataDir)?.tier),
  });
}

/** `hamness logout <provider>`: remove the login Pi stored for it (`openai`: the plan's too). */
export async function logoutCommand({ args, dataDir, io }: CliContext): Promise<number> {
  const [provider, extra] = args;
  if (!provider || extra !== undefined) {
    io.err(LOGOUT_USAGE);
    return 2;
  }
  const runtime = await createRuntime(dataDir);
  if (provider === OLDER_OPENAI_LOGOUT) {
    await runtime.logout("openai");
    io.out("Signed out of the older OpenAI sign-in (openai). The ChatGPT plan login is kept.");
    return 0;
  }
  const target = loginProvider(provider);
  await runtime.logout(target);
  // A ChatGPT login stored before ADR 0024 sits under `openai`; signing out of the plan removes it.
  if (target !== provider) await runtime.logout(provider);
  io.out(`Signed out of ${provider}.`);
  return 0;
}
