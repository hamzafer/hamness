import { statSync } from "node:fs";
import { defaultModelCredential } from "../../agent/models.ts";
import { hookSources } from "../../compat/hooks.ts";
import { loadCompat } from "../../compat/index.ts";
import { claudeConfigDir, claudeManagedDir, managedDirOption } from "../../compat/paths.ts";
import { getStatus } from "../../daemon/status.ts";
import { loadSafetyConfig } from "../../safety/config.ts";
import { judgeFromKeys } from "../../safety/judge/index.ts";
import type { CliContext } from "../run.ts";
import { keyHowTo, modeSummary } from "../setup.ts";

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
    if (cred.source === "none") {
      checks.push({
        level: "fail",
        text: `${cred.model}: no API key`,
        fix: keyHowTo(cred, dataDir),
      });
    } else {
      const from =
        cred.source === "env"
          ? `from ${cred.envName}`
          : cred.source === "file"
            ? "from the key file"
            : "signed in";
      checks.push({ level: "ok", text: `${cred.model}: key ${from}` });
    }
  } catch (err) {
    checks.push({ level: "fail", text: `Model key: ${(err as Error).message}` });
  }

  let judgeOn = false;
  try {
    judgeOn = judgeFromKeys({ dataDir, env }) !== undefined;
  } catch {
    // The key file's problem is reported by the key check above.
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
      text: `Claude Code: ${plural(setup.instructions.files.length, "instruction file")}, ${plural(setup.skills.skills.length, "skill")}, ${plural(setup.mcp.servers.length, "MCP server")}${waiting ? ` (${waiting} waiting for \`hamness compat approve\`)` : ""}, ${plural(hooks, "hook")} (details: \`hamness compat\`)`,
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
