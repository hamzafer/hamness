import { approvedMcp, approveMcp, revokeMcp } from "../trust/index.ts";
import { projectKey } from "./paths.ts";

/**
 * Approvals for project MCP servers (a repo's `.mcp.json`). A repo's servers run code, so they
 * start only after the user approves them for that repo, like Claude Code's prompt. They are
 * part of repo trust (`src/trust`, ADR 0020): kept in hamness's user config, never in the repo,
 * keyed on a fingerprint of the server's definition, so an edited entry asks again.
 */

export { projectKey };
export type Approvals = Record<string, Record<string, string>>;

/** The approved servers for the project holding `cwd`: name to fingerprint. */
export const readApprovals = (dataDir: string, cwd: string): Record<string, string> =>
  approvedMcp(dataDir, projectKey(cwd));

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
  const byKey = new Map<string, Record<string, string>>();
  for (const s of pending) {
    const key = s.projectKey as string;
    byKey.set(key, { ...(byKey.get(key) ?? {}), [s.name]: s.fingerprint as string });
  }
  for (const [key, approved] of byKey) approveMcp(dataDir, key, approved);
  return pending.map((s) => s.name);
}

/** Forgets the approvals for a folder's repo (all, or the named servers). Returns what was removed. */
export function revokeProjectServers(dataDir: string, cwd: string, only?: string[]): string[] {
  return revokeMcp(dataDir, projectKey(cwd), only);
}
