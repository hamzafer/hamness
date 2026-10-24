import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { userConfigPath } from "../safety/config.ts";
import { repoRoot } from "./paths.ts";

/**
 * Approvals for project MCP servers (a repo's `.mcp.json`). A repo's servers run code, so they
 * start only after the user approves them once for that repo, like Claude Code's prompt.
 * Kept in hamness's user config (`<dataDir>/config.json`), never in the repo, so a repo can't
 * approve itself, and never in Claude Code's files (ADR 0008):
 *
 * ```json
 * { "compat": { "mcpApprovals": { "/abs/repo": { "github": "<fingerprint>" } } } }
 * ```
 * The fingerprint covers the server's definition, so an edited entry asks again.
 */

type Json = Record<string, unknown>;
export type Approvals = Record<string, Record<string, string>>;

/** The key a folder's approvals live under: its repo root (or itself), symlinks resolved. */
export function projectKey(cwd: string): string {
  const root = repoRoot(cwd) ?? resolve(cwd);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function readConfig(dataDir: string): Json {
  const path = userConfigPath(dataDir);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: must hold a JSON object`);
  }
  return parsed as Json;
}

export function readApprovals(dataDir: string): Approvals {
  let config: Json;
  try {
    config = readConfig(dataDir);
  } catch {
    return {};
  }
  const block = (config.compat as Json | undefined)?.mcpApprovals;
  return block && typeof block === "object" && !Array.isArray(block) ? (block as Approvals) : {};
}

function writeApprovals(dataDir: string, approvals: Approvals): void {
  const path = userConfigPath(dataDir);
  const config = readConfig(dataDir);
  const compat = { ...((config.compat as Json | undefined) ?? {}), mcpApprovals: approvals };
  config.compat = compat;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

interface Approvable {
  name: string;
  scope: string;
  status: string;
  projectKey?: string;
  fingerprint?: string;
}

/** Approves the project servers waiting for approval. Returns their names. */
export function approveProjectServers(
  dataDir: string,
  servers: Approvable[],
  only?: string[],
): string[] {
  const pending = servers.filter(
    (s) =>
      s.scope === "project" &&
      s.status === "needs-approval" &&
      s.projectKey &&
      s.fingerprint &&
      (!only || only.includes(s.name)),
  );
  if (pending.length === 0) return [];
  const approvals = readApprovals(dataDir);
  for (const s of pending) {
    const key = s.projectKey as string;
    approvals[key] = { ...(approvals[key] ?? {}), [s.name]: s.fingerprint as string };
  }
  writeApprovals(dataDir, approvals);
  return pending.map((s) => s.name);
}

/** Forgets the approvals for a folder's repo (all, or the named servers). Returns what was removed. */
export function revokeProjectServers(dataDir: string, cwd: string, only?: string[]): string[] {
  const key = projectKey(cwd);
  const approvals = readApprovals(dataDir);
  const current = approvals[key];
  if (!current) return [];
  const removed = Object.keys(current).filter((n) => !only || only.includes(n));
  if (removed.length === 0) return [];
  const kept = Object.fromEntries(Object.entries(current).filter(([n]) => !removed.includes(n)));
  if (Object.keys(kept).length > 0) approvals[key] = kept;
  else delete approvals[key];
  writeApprovals(dataDir, approvals);
  return removed;
}
