import { projectHookItems } from "../compat/hooks.ts";
import { loadMcpServers } from "../compat/mcp.ts";
import { type ClaudeEnv, projectKey, projectRoot } from "../compat/paths.ts";
import { isObject, readJson } from "../config/json.ts";
import { projectConfigPath } from "../safety/config.ts";
import { parsePermission } from "../safety/rules.ts";
import {
  addTrusted,
  allowItem,
  approveMcp,
  isTrusted,
  proofItem,
  revokeTrust,
  trustRecord,
} from "./index.ts";

/** One thing a repo brings that needs the user's trust, and where it stands. */
export interface TrustEntry {
  label: string;
  /** Where it is defined. */
  source: string;
  state: "trusted" | "not trusted" | "new or changed" | "changed";
}

export interface TrustReport {
  /** The project root and the key its trust lives under. */
  root: string;
  key: string;
  /** Project allow rules and proof commands. */
  safety: TrustEntry[];
  hooks: TrustEntry[];
  mcp: TrustEntry[];
}

interface Options {
  dataDir: string;
  cwd: string;
  claude: ClaudeEnv;
}

/** The project config's `proof.commands`: commands whose passing re-run counts as proof. */
function proofCommands(file: Record<string, unknown> | undefined): string[] {
  const proof = file?.proof;
  const commands = isObject(proof) ? proof.commands : undefined;
  return Array.isArray(commands) ? commands.filter((c): c is string => typeof c === "string") : [];
}

function collect(opts: Options) {
  const key = projectKey(opts.cwd);
  const path = projectConfigPath(opts.cwd);
  const file = readJson(path);
  const safetyBlock = isObject(file?.safety) ? file.safety : {};
  const allows = parsePermission(safetyBlock.permission, "project").filter(
    (r) => r.verdict === "allow",
  );
  const safety = [
    ...allows.map((r) => ({
      label: `${r.tool} "${r.pattern}" allow`,
      item: allowItem(r.tool, r.pattern) as unknown,
    })),
    ...proofCommands(file).map((c) => ({ label: `proof "${c}"`, item: proofItem(c) as unknown })),
  ].map((e) => ({ ...e, source: path }));
  const hooks = projectHookItems(opts.cwd).map((h) => ({
    label: h.label,
    item: h.item,
    source: h.file,
  }));
  const mcp = loadMcpServers(opts).servers.filter(
    (s) =>
      s.scope === "project" &&
      s.fingerprint &&
      (s.status === "start" || s.status === "needs-approval"),
  );
  return { key, safety, hooks, mcp };
}

/** What the repo holding `cwd` brings, and which of it is trusted (`hamness trust --show`). */
export function trustReport(opts: Options): TrustReport {
  const { key, safety, hooks, mcp } = collect(opts);
  const record = trustRecord(opts.dataDir, key);
  const state = (section: "safety" | "hooks", item: unknown): TrustEntry["state"] =>
    isTrusted(opts.dataDir, key, section, item)
      ? "trusted"
      : record[section]
        ? "new or changed"
        : "not trusted";
  const approved = isObject(record.mcp) ? record.mcp : {};
  return {
    root: projectRoot(opts.cwd),
    key,
    safety: safety.map((e) => ({
      label: e.label,
      source: e.source,
      state: state("safety", e.item),
    })),
    hooks: hooks.map((e) => ({ label: e.label, source: e.source, state: state("hooks", e.item) })),
    mcp: mcp.map((s) => ({
      label: s.name,
      source: s.source,
      state:
        approved[s.name] === s.fingerprint
          ? "trusted"
          : s.name in approved
            ? "changed"
            : "not trusted",
    })),
  };
}

/** Trusts everything the repo holding `cwd` brings, as it is now. Returns the report before. */
export function trustAll(opts: Options): TrustReport {
  const before = trustReport(opts);
  const { key, safety, hooks, mcp } = collect(opts);
  addTrusted(
    opts.dataDir,
    key,
    "safety",
    safety.map((e) => e.item),
  );
  addTrusted(
    opts.dataDir,
    key,
    "hooks",
    hooks.map((e) => e.item),
  );
  approveMcp(opts.dataDir, key, Object.fromEntries(mcp.map((s) => [s.name, s.fingerprint ?? ""])));
  return before;
}

/** Forgets all trust for the repo holding `cwd`. False when nothing was trusted. */
export const revokeAll = (dataDir: string, cwd: string): boolean =>
  revokeTrust(dataDir, projectKey(cwd));
