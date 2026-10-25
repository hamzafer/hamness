import { statSync } from "node:fs";
import { envKeyName, readKeyFile } from "../../agent/keys.ts";
import {
  billingLabel,
  defaultModelCredential,
  PLAN_DEFAULT_MODEL,
  PLAN_PROVIDER,
  PLAN_TIER_MODEL,
} from "../../agent/models.ts";
import { readPlanLogin, tierLabel } from "../../agent/plan.ts";
import { hookSources } from "../../compat/hooks.ts";
import { loadCompat } from "../../compat/index.ts";
import { claudeConfigDir, claudeManagedDir, managedDirOption } from "../../compat/paths.ts";
import type { Env } from "../../config/paths.ts";
import { describeDaemon, findDaemons } from "../../daemon/processes.ts";
import { getStatus } from "../../daemon/status.ts";
import { loadJudgeConfig, loadSafetyConfig } from "../../safety/config.ts";
import { chooseJudge } from "../../safety/judge/index.ts";
import type { CliContext } from "../run.ts";
import { API_KEYS_OPTIONAL, modeSummary, SIGN_IN, setupSteps } from "../setup.ts";

export const DOCTOR_USAGE = [
  "Usage: hamness doctor",
  "",
  "Checks the setup for this directory and says what to fix: the Bun version, the model's",
  "key (named, never printed), the safety mode, the daemon, the data dir's permissions,",
  "the config files, gh (for ci evidence), the TUI and what Claude Code setup is found.",
  "Exits 1 when something must be fixed before chat works.",
].join("\n");

/** The Bun version hamness needs (package.json `engines`). */
export const MIN_BUN = "1.4.4";

type Level = "ok" | "warn" | "fail" | "info";
interface Check {
  level: Level;
  text: string;
  /** Extra lines under the check: how to fix it. */
  fix?: string[];
}

function newerOrEqual(version: string, min: string): boolean {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function gh(path: string | undefined): Promise<Check> {
  const bin = Bun.which("gh", { PATH: path ?? "" });
  if (!bin) {
    return {
      level: "warn",
      text: "gh not found: ci evidence can't be checked (install the GitHub CLI and run `gh auth login`)",
    };
  }
  const proc = Bun.spawn([bin, "auth", "status"], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  return code === 0
    ? { level: "ok", text: "gh found and signed in (ci evidence works)" }
    : { level: "warn", text: "gh found but not signed in: run `gh auth login` for ci evidence" };
}

async function tuiLoads(): Promise<Check> {
  try {
    const { loadTui } = await import("../../tui/loader.ts");
    await loadTui();
    return { level: "ok", text: "TUI loads" };
  } catch (err) {
    return { level: "fail", text: `TUI does not load: ${(err as Error).message.split("\n")[0]}` };
  }
}

/** The plan tier's default model id (`PLAN_TIER_MODEL`, else `PLAN_DEFAULT_MODEL`). */
const planDefaultId = (tier: string | undefined) =>
  (tier && PLAN_TIER_MODEL[tier]) || PLAN_DEFAULT_MODEL.slice(PLAN_DEFAULT_MODEL.indexOf("/") + 1);

const KNOWN_KEYS = ["anthropic", "openai", "google", "openrouter", "xai", "mistral", "groq"];

/** Which API keys exist (names only), and that they are optional and pay per token. */
function apiKeysLine(dataDir: string, env: Env): string {
  const file = readKeyFile(dataDir);
  const found = [...new Set([...KNOWN_KEYS, ...Object.keys(file)])]
    .map((p) => envKeyName(p, env) ?? (file[p] ? `${p} (key file)` : undefined))
    .filter((x): x is string => x !== undefined);
  return found.length
    ? `API keys: ${found.join(", ")} (pay per token; used only by API models you pick)`
    : `API keys: none (${API_KEYS_OPTIONAL})`;
}

/** `hamness doctor`: one line per check, `ok` / `warn` / `fail`. */
export async function doctorCommand({ env, dataDir, io }: CliContext): Promise<number> {
  const cwd = process.cwd();
  const checks: Check[] = [];

  checks.push(
    newerOrEqual(Bun.version, MIN_BUN)
      ? { level: "ok", text: `Bun ${Bun.version}` }
      : {
          level: "fail",
          text: `Bun ${Bun.version} is too old: hamness needs ${MIN_BUN} or newer (bun upgrade)`,
        },
  );

  try {
    const cred = await defaultModelCredential({ dataDir, env });
    const plan = readPlanLogin(dataDir);
    // Pi's Codex calls need the account id in the token; without it every plan call fails.
    const badPlanLogin = plan !== undefined && !plan.hasAccount;
    if (!cred.model) {
      checks.push({ level: "fail", text: "Model: not set up", fix: setupSteps(cred, dataDir) });
    } else if (badPlanLogin && cred.provider === PLAN_PROVIDER) {
      checks.push({
        level: "fail",
        text: `Model ${cred.model}: the ChatGPT plan login has no account id, so its calls fail`,
        fix: ["  Sign in again: hamness login openai"],
      });
    } else if (!cred.billing) {
      checks.push({
        level: "fail",
        text: `Model ${cred.model}: no key or login`,
        fix: setupSteps(cred, dataDir),
      });
    } else {
      const why =
        cred.origin === "env"
          ? " (HAMNESS_MODEL)"
          : cred.origin === "config"
            ? " (defaultModel)"
            : "";
      checks.push({
        level: "ok",
        text: `Model ${cred.model}${why}: ${billingLabel(cred.billing, true)}`,
      });
    }
    if (badPlanLogin && cred.provider !== PLAN_PROVIDER) {
      checks.push({
        level: "warn",
        text: "ChatGPT plan login has no account id, so the plan's models can't be reached",
        fix: ["  Sign in again: hamness login openai"],
      });
    } else if (plan && !badPlanLogin) {
      checks.push({
        level: "info",
        text: `ChatGPT plan: ${tierLabel(plan.tier)} · default ${planDefaultId(plan.tier)}`,
      });
    } else if (cred.legacyOpenaiLogin) {
      checks.push({
        level: "warn",
        text: "An older ChatGPT login is stored under openai; the plan's Codex models need a new one",
        fix: [`  ${SIGN_IN}`],
      });
    }
    checks.push({ level: "info", text: apiKeysLine(dataDir, env) });
  } catch (err) {
    checks.push({ level: "fail", text: `Model: ${(err as Error).message}` });
  }

  let judgeOn = false;
  try {
    const judge = await chooseJudge({ dataDir, env });
    judgeOn = judge.backend !== undefined;
    checks.push(
      judge.backend
        ? {
            level: "info",
            text: `Judge ${judge.model}: ${judge.billing === "plan" ? `ChatGPT plan, up to ${loadJudgeConfig(dataDir).dailyCallCap} calls a day` : "API (pay per token, daily $ budget)"}`,
          }
        : { level: "info", text: `Judge off: ${judge.off}` },
    );
  } catch {
    // A broken key file or config is reported by the checks around this one.
  }
  try {
    const config = loadSafetyConfig(dataDir, cwd);
    checks.push({ level: "ok", text: "Config files are valid" });
    checks.push({ level: "info", text: `Safety mode ${modeSummary(config.mode, judgeOn)}` });
  } catch (err) {
    checks.push({ level: "fail", text: `Config: ${(err as Error).message}` });
  }

  try {
    const mode = statSync(dataDir).mode & 0o777;
    checks.push(
      mode & 0o077
        ? { level: "warn", text: `Data dir ${dataDir} is readable by others (chmod 700 it)` }
        : { level: "ok", text: `Data dir ${dataDir}` },
    );
  } catch {
    checks.push({ level: "info", text: `Data dir ${dataDir} (created on first run)` });
  }

  const status = await getStatus(dataDir);
  checks.push(
    status.running
      ? { level: "ok", text: `Daemon running (pid ${status.pid}, ${status.url})` }
      : { level: "info", text: "Daemon not running (`hamness` starts it)" },
  );
  const strays = findDaemons(dataDir).filter(
    (p) => p.pid !== process.pid && (!status.running || p.pid !== status.pid),
  );
  if (strays.length) {
    checks.push({
      level: "warn",
      text: `${plural(strays.length, "stray daemon process")} for this data dir, not answering: ${strays.map(describeDaemon).join(", ")}`,
      fix: ["Stop them all with `hamness stop --all` (then `hamness` starts a fresh one)"],
    });
  }

  checks.push(await gh(env.PATH));

  try {
    const setup = loadCompat({ cwd, dataDir, claude: { env } });
    const hooks = hookSources(
      { claudeDir: claudeConfigDir(env), dataDir, ...managedDirOption(claudeManagedDir({ env })) },
      cwd,
    ).reduce((n, s) => n + (s.runs ? s.hooks.length : 0), 0);
    const waiting = setup.mcp.servers.filter((s) => s.status === "needs-approval").length;
    checks.push({
      level: "info",
      text: `Claude Code: ${plural(setup.instructions.files.length, "instruction file")}, ${plural(setup.skills.skills.length, "skill")}, ${plural(setup.mcp.servers.length, "MCP server")}${waiting ? ` (${waiting} waiting for \`hamness trust\`)` : ""}, ${plural(hooks, "hook")} (details: \`hamness compat\`)`,
    });
  } catch (err) {
    checks.push({ level: "warn", text: `Claude Code setup: ${(err as Error).message}` });
  }

  checks.push(await tuiLoads());

  for (const c of checks) {
    io.out(`${c.level.padEnd(5)} ${c.text}`);
    for (const f of c.fix ?? []) io.out(`     ${f}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  io.out("");
  io.out(failed ? `${plural(failed, "problem")} to fix before chat works.` : "Ready.");
  return failed ? 1 : 0;
}
