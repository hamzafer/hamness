import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { revokeAll, type TrustReport, trustAll, trustReport } from "../../trust/report.ts";
import type { CliContext } from "../run.ts";

export const TRUST_USAGE = [
  "Usage: hamness trust [dir]            Trust what the repo holding dir brings, as it is now",
  "       hamness trust --show [dir]     List it and what changed since you last trusted it",
  "       hamness trust --revoke [dir]   Forget the repo's trust",
  "",
  "A repo can bring things that loosen safety or run code. They wait for your trust:",
  "  - allow rules and proof commands in .hamness/config.json (its ask and deny rules always apply)",
  "  - Claude Code hooks in .claude/settings.json and settings.local.json",
  "  - MCP servers in .mcp.json",
  "Each item is trusted as it is: an added or edited one waits until you trust again.",
  "Trust lives in hamness's config (<data dir>/config.json), never in the repo.",
  "`hamness hooks trust` and `hamness compat approve` do the same.",
].join("\n");

const SECTIONS = [
  ["safety", "Allow rules and proof commands (.hamness/config.json)"],
  ["hooks", "Claude Code hooks (.claude/settings*.json)"],
  ["mcp", "MCP servers (.mcp.json)"],
] as const;

function print(report: TrustReport, out: (line: string) => void): void {
  const all = [...report.safety, ...report.hooks, ...report.mcp];
  const trusted = all.filter((e) => e.state === "trusted").length;
  const summary =
    all.length === 0
      ? "brings nothing that needs trust"
      : trusted === all.length
        ? "trusted"
        : trusted === 0
          ? "not trusted"
          : `${trusted} of ${all.length} trusted`;
  out(`${report.root}: ${summary}`);
  for (const [section, title] of SECTIONS) {
    const entries = report[section];
    if (entries.length === 0) continue;
    out("");
    out(`${title}:`);
    for (const e of entries) out(`  ${e.state.padEnd(16)}${e.label}`);
  }
}

export async function trustCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  let values: { show?: boolean; revoke?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: { show: { type: "boolean" }, revoke: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    io.err(`hamness trust: ${(e as Error).message}`);
    io.err(TRUST_USAGE);
    return 2;
  }
  if (positionals.length > 1 || (values.show && values.revoke)) {
    io.err(TRUST_USAGE);
    return 2;
  }
  const cwd = resolve(positionals[0] ?? process.cwd());
  const opts = { dataDir, cwd, claude: { env } };

  if (values.revoke) {
    const report = trustReport(opts);
    io.out(
      revokeAll(dataDir, cwd)
        ? `Revoked trust for ${report.root}. Its allow rules, proof commands, hooks and MCP servers wait for trust again.`
        : `Nothing was trusted for ${report.root}.`,
    );
    return 0;
  }
  if (values.show) {
    print(trustReport(opts), io.out);
    return 0;
  }
  const before = trustAll(opts);
  const added = [...before.safety, ...before.hooks, ...before.mcp].filter(
    (e) => e.state !== "trusted",
  );
  io.out(`Trusted ${before.root}${added.length ? ":" : " (nothing new)."}`);
  for (const e of added) io.out(`  ${e.label}`);
  if (added.length)
    io.out("These apply from the next tool call; new sessions start the MCP servers.");
  return 0;
}
