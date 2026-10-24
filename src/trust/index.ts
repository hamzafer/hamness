import { createHash } from "node:crypto";
import { isObject, type Json, readJson, readJsonOr, writeJsonAtomic } from "../config/json.ts";
import { userConfigFile } from "../config/paths.ts";

/**
 * Repo trust (ADR 0020). What a repo brings that could loosen safety or run code only takes
 * effect once the user trusts it with `hamness trust`:
 *
 * - `safety`: the project's allow rules and proof commands (`.hamness/config.json`)
 * - `hooks`: the project's Claude Code hooks (`.claude/settings*.json`)
 * - `mcp`: the project's MCP servers (`.mcp.json`), by name
 *
 * Trust is a set of fingerprints per item, so an edited or added item is untrusted until the
 * user trusts it again, while a worktree holding fewer items than its repo stays trusted. It is
 * kept per project (`projectKey`) in hamness's user config, never in the repo:
 *
 * ```json
 * { "trust": { "projects": { "/abs/repo": { "safety": ["<fp>"], "hooks": ["<fp>"],
 *                                            "mcp": { "github": "<fp>" }, "trustedAt": "..." } } } }
 * ```
 */

export type ItemSection = "safety" | "hooks";
export type TrustSection = ItemSection | "mcp";

export interface TrustRecord {
  safety?: string[];
  hooks?: string[];
  /** Server name to the fingerprint of its definition. */
  mcp?: Record<string, string>;
  trustedAt?: string;
}

/** JSON with object keys sorted, so equal values always print the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A short hash of a value's stable JSON. */
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);

/** The `safety` item for a project allow rule. */
export const allowItem = (tool: string, pattern: string) => ({ kind: "allow", tool, pattern });
/** The `safety` item for a project proof command. */
export const proofItem = (command: string) => ({ kind: "proof", command });

const FILE_MODE = 0o600;

function readProjects(dataDir: string): Record<string, TrustRecord> {
  const config = readJsonOr(userConfigFile(dataDir));
  const projects = isObject(config?.trust) ? (config.trust as Json).projects : undefined;
  return isObject(projects) ? (projects as Record<string, TrustRecord>) : {};
}

/** Every trusted project's record. A broken config file trusts nothing. */
export const readTrust = readProjects;

export function trustRecord(dataDir: string, key: string): TrustRecord {
  const record = readProjects(dataDir)[key];
  return isObject(record) ? record : {};
}

function update(dataDir: string, change: (projects: Record<string, TrustRecord>) => void): void {
  const path = userConfigFile(dataDir);
  // A broken file throws here: never overwrite the user's settings with a fresh object.
  const config = readJson(path) ?? {};
  const trust = isObject(config.trust) ? { ...config.trust } : {};
  const projects = isObject(trust.projects)
    ? { ...(trust.projects as Record<string, TrustRecord>) }
    : {};
  change(projects);
  trust.projects = projects;
  config.trust = trust;
  writeJsonAtomic(path, config, FILE_MODE);
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function isTrusted(dataDir: string, key: string, section: ItemSection, item: unknown) {
  return list(trustRecord(dataDir, key)[section]).includes(fingerprint(item));
}

/** Adds items to a section's trusted set. */
export function addTrusted(dataDir: string, key: string, section: ItemSection, items: unknown[]) {
  if (items.length === 0) return;
  update(dataDir, (projects) => {
    const record = { ...(projects[key] ?? {}) };
    const set = new Set(list(record[section]));
    for (const item of items) set.add(fingerprint(item));
    record[section] = [...set];
    record.trustedAt = new Date().toISOString();
    projects[key] = record;
  });
}

/** Replaces a section's trusted set with exactly these items. */
export function setTrusted(dataDir: string, key: string, section: ItemSection, items: unknown[]) {
  update(dataDir, (projects) => {
    const record = { ...(projects[key] ?? {}) };
    record[section] = [...new Set(items.map(fingerprint))];
    record.trustedAt = new Date().toISOString();
    projects[key] = record;
  });
}

/** The approved MCP servers for a project: name to definition fingerprint. */
export function approvedMcp(dataDir: string, key: string): Record<string, string> {
  const mcp = trustRecord(dataDir, key).mcp;
  return isObject(mcp) ? (mcp as Record<string, string>) : {};
}

/** Approves MCP servers (name to fingerprint) for a project, keeping the others. */
export function approveMcp(dataDir: string, key: string, servers: Record<string, string>) {
  if (Object.keys(servers).length === 0) return;
  update(dataDir, (projects) => {
    const record = { ...(projects[key] ?? {}) };
    record.mcp = { ...(isObject(record.mcp) ? record.mcp : {}), ...servers };
    record.trustedAt = new Date().toISOString();
    projects[key] = record;
  });
}

/** Forgets named MCP approvals (all when `names` is undefined). Returns the names removed. */
export function revokeMcp(dataDir: string, key: string, names?: string[]): string[] {
  const current = approvedMcp(dataDir, key);
  const removed = Object.keys(current).filter((n) => !names || names.includes(n));
  if (removed.length === 0) return [];
  update(dataDir, (projects) => {
    const record = { ...(projects[key] ?? {}) };
    record.mcp = Object.fromEntries(Object.entries(current).filter(([n]) => !removed.includes(n)));
    projects[key] = record;
  });
  return removed;
}

/** Forgets a project's trust: one section, or all of it. False when there was nothing. */
export function revokeTrust(dataDir: string, key: string, section?: TrustSection): boolean {
  const record = readProjects(dataDir)[key];
  if (!record || (section && record[section] === undefined)) return false;
  update(dataDir, (projects) => {
    if (!section) {
      delete projects[key];
      return;
    }
    const next = { ...record };
    delete next[section];
    projects[key] = next;
  });
  return true;
}
