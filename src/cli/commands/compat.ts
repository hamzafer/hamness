import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  approveProjectServers,
  type CompatSetup,
  loadCompat,
  revokeProjectServers,
} from "../../compat/index.ts";
import { claudeConfigDir } from "../../compat/paths.ts";
import type { CliContext } from "../run.ts";

export const COMPAT_USAGE = [
  "Usage: hamness compat [--cwd <dir>] [--json]",
  "       hamness compat approve [server...]",
  "       hamness compat revoke [server...]",
  "",
  "Shows what a session in this folder picks up from Claude Code: instruction files",
  "(CLAUDE.md, AGENTS.md, rules), skills and MCP servers, and what hamness does with each.",
  "hamness only reads Claude Code's files; it never changes them.",
  "",
  "A repo's own MCP servers (.mcp.json) run code, so they start only once you approve them",
  "for that repo. `approve` approves the waiting ones (or the named ones); `revoke` forgets them.",
  "Approvals live in hamness's config, not in the repo or in Claude Code's files.",
  "",
  "  --cwd <dir>  The folder to check (default: the current one)",
  "  --json       Print the findings as JSON",
].join("\n");

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length));

function report(setup: CompatSetup, configDir: string, out: (line: string) => void): void {
  const { instructions, skills, mcp } = setup;
  out(`Claude Code config: ${configDir}`);
  out("");
  out(`Instruction files (${instructions.mode}):`);
  if (instructions.files.length === 0) out("  none found");
  for (const f of instructions.files) {
    const imports = f.imports.length ? `  (+${f.imports.length} imported)` : "";
    out(`  ${pad(f.scope, 9)}${f.path}${imports}`);
  }
  for (const s of instructions.skipped) out(`  ${pad("skipped", 9)}${s.path}: ${s.reason}`);

  out("");
  out("Skills:");
  if (skills.skills.length === 0) out("  none found");
  const width = Math.max(8, ...skills.skills.map((s) => s.name.length + 2));
  for (const s of skills.skills) {
    const note = s.disableModelInvocation ? "  [user only: not offered to the model]" : "";
    out(`  ${pad(s.name, width)}${pad(s.scope, 9)}${s.description}${note}`);
    if (s.ignoredFields.length)
      out(`  ${" ".repeat(width + 9)}not honored: ${s.ignoredFields.join(", ")}`);
  }
  for (const s of skills.skipped) out(`  ${pad("skipped", width + 9)}${s.path}: ${s.reason}`);

  out("");
  out("MCP servers:");
  if (mcp.servers.length === 0) out("  none found");
  const nameWidth = Math.max(8, ...mcp.servers.map((s) => s.name.length + 2));
  for (const s of mcp.servers) {
    const status = s.status === "needs-approval" ? "needs approval" : s.status;
    const transport = s.config ? ("url" in s.config ? "http" : "stdio") : "";
    const why = s.reason ? `  ${s.reason}` : "";
    out(
      `  ${pad(s.name, nameWidth)}${pad(s.scope, 9)}${pad(status, 16)}${pad(transport, 6)}${s.source}${why}`,
    );
    for (const w of s.warnings) out(`  ${" ".repeat(nameWidth + 9)}warning: ${w}`);
  }
  if (mcp.servers.some((s) => s.status === "start")) {
    out("  Their tools are named mcp__<server>__<tool> and pass the safety rules like any tool.");
  }
  if (mcp.servers.some((s) => s.status === "needs-approval")) {
    out("  Run `hamness compat approve` to start the waiting project servers in new sessions.");
  }
  if (mcp.errors.length) {
    out("");
    out("Problems:");
    for (const e of mcp.errors) out(`  ${e}`);
  }
}

export async function compatCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  let values: { cwd?: string; json?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        cwd: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    io.err(`hamness compat: ${(e as Error).message}`);
    io.err(COMPAT_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(COMPAT_USAGE);
    return 0;
  }
  const cwd = resolve(values.cwd ?? process.cwd());
  const claude = { env };
  const load = () => loadCompat({ cwd, dataDir, claude });
  const [sub, ...names] = positionals;
  const only = names.length ? names : undefined;

  if (sub === "approve") {
    const approved = approveProjectServers(dataDir, load().mcp.servers, only);
    io.out(
      approved.length
        ? `Approved ${approved.join(", ")} for ${cwd}. New sessions here start them.`
        : "No project MCP servers wait for approval here.",
    );
    return 0;
  }
  if (sub === "revoke") {
    const revoked = revokeProjectServers(dataDir, cwd, only);
    io.out(
      revoked.length
        ? `Revoked ${revoked.join(", ")} for ${cwd}. New sessions here won't start them.`
        : "No approved project MCP servers here.",
    );
    return 0;
  }
  if (sub !== undefined) {
    io.err(`hamness compat: unknown subcommand '${sub}'`);
    io.err(COMPAT_USAGE);
    return 2;
  }

  const setup = load();
  if (values.json) {
    io.out(JSON.stringify(setup, null, 2));
    return 0;
  }
  report(setup, claudeConfigDir(claude), io.out);
  return 0;
}
