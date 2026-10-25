import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CliIo } from "../cli/io.ts";

/** The part of Pi's runtime a login needs. Tests pass a fake. */
export type LoginRuntime = Pick<ModelRuntime, "login">;

/**
 * Providers hamness will not log in to. Claude Pro/Max subscriptions are for Claude Code;
 * using them in a third-party harness risks Anthropic's terms (ADR 0011). Use an API key.
 */
const NO_SUBSCRIPTION_LOGIN: Readonly<Record<string, string>> = {
  anthropic:
    "hamness does not sign in with a Claude subscription (its terms cover Claude Code only). Use an API key: `hamness keys set anthropic` or ANTHROPIC_API_KEY.",
};

/** A stable id for this install, which OpenAI's login asks for. Kept in `<dataDir>/pi/device-id`. */
function deviceId(dataDir: string): string {
  const dir = join(dataDir, "pi");
  const path = join(dir, "device-id");
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

function interaction(io: CliIo): AuthInteraction {
  const ask = async (p: AuthPrompt): Promise<string> => {
    if (p.type === "select") {
      p.options.forEach((o, n) => {
        io.out(`  ${n + 1}. ${o.label}${o.description ? ` (${o.description})` : ""}`);
      });
      const answer = ((await io.readLine?.(`${p.message} [1-${p.options.length}]: `)) ?? "").trim();
      const picked = p.options[Number(answer) - 1] ?? p.options.find((o) => o.id === answer);
      if (!picked) throw new Error("no option chosen");
      return picked.id;
    }
    const read = p.type === "secret" ? io.readSecret : io.readLine;
    if (!read) throw new Error("this login needs input, and there is no terminal to ask");
    return read(`${p.message}: `);
  };
  return {
    prompt: ask,
    notify(e) {
      if (e.type === "auth_url") {
        io.out(`Open this URL in a browser to sign in:\n  ${e.url}`);
        if (e.instructions) io.out(e.instructions);
      } else if (e.type === "device_code") {
        io.out(`Go to ${e.verificationUri} and enter the code ${e.userCode}`);
      } else {
        io.out(e.message);
      }
    },
  };
}

/**
 * What `hamness login <name>` signs in to. `openai` (and `chatgpt`) is the ChatGPT plan: Pi's
 * `openai-codex` provider, OAuth only, so no API key can reach its models (ADR 0024).
 */
const LOGIN_PROVIDER: Readonly<Record<string, string>> = {
  openai: "openai-codex",
  chatgpt: "openai-codex",
};

export const loginProvider = (name: string) => LOGIN_PROVIDER[name] ?? name;

/** A login error, with what to do for the ones hamness knows. */
export function explainLoginError(message: string): string {
  if (/3p_delegated_access_policy_denied/.test(message)) {
    return [
      "your ChatGPT workspace does not allow third-party apps to sign in (3p_delegated_access_policy_denied).",
      "Ask the workspace admin to allow it, or sign in with a personal ChatGPT account",
      "(pick the device code option, or sign out of the workspace in the browser first).",
    ].join("\n  ");
  }
  return message;
}

/**
 * `hamness login <provider>`: runs Pi's OAuth flow (`openai`: the ChatGPT plan, see
 * `LOGIN_PROVIDER`). Pi stores the credential in `<dataDir>/pi/auth.json` (mode 0600); nothing
 * here prints it. `planModel` is the default model the plan gives, for the closing line.
 */
export async function login(opts: {
  provider: string;
  runtime: LoginRuntime;
  io: CliIo;
  dataDir: string;
  planModel?: (provider: string) => string | undefined;
}): Promise<number> {
  const refusal = NO_SUBSCRIPTION_LOGIN[opts.provider];
  if (refusal) {
    opts.io.err(refusal);
    return 1;
  }
  const provider = loginProvider(opts.provider);
  try {
    await opts.runtime.login(provider, "oauth", interaction(opts.io), {
      getDeviceId: () => deviceId(opts.dataDir),
      agentName: "hamness",
    });
  } catch (err) {
    opts.io.err(`hamness login: ${explainLoginError((err as Error).message)}`);
    return 1;
  }
  if (provider === "openai-codex") {
    const model = opts.planModel?.(provider);
    const id = model?.slice(model.indexOf("/") + 1) ?? "gpt-5.6-terra";
    opts.io.out(`Signed in with your ChatGPT plan. Default model: ${id} (plan).`);
  } else {
    opts.io.out(`Signed in to ${provider}.`);
  }
  opts.io.out(
    "Restart the daemon (`hamness stop`, then `hamness`) for running sessions to use it.",
  );
  return 0;
}
