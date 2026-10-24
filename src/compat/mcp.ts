import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { isObject, type Json, readJsonOr } from "../config/json.ts";
import { scriptRef } from "../trust/scripts.ts";
import { readApprovals } from "./approvals.ts";
import {
  ancestorsDown,
  type ClaudeEnv,
  claudeGlobalConfigFile,
  claudeSettingsFiles,
  projectKey,
  repoRoot,
} from "./paths.ts";

/**
 * MCP servers from Claude Code's config (https://code.claude.com/docs/en/mcp), for Pi's MCP client:
 *
 * - user: `mcpServers` in `.claude.json` (see `claudeGlobalConfigFile`)
 * - local: `projects["<project path>"].mcpServers` in the same file
 * - project: `.mcp.json` in the cwd or a folder above it up to the repo root, nearest first
 *
 * A name defined in more than one scope uses the whole entry from local, then project, then user.
 * `${VAR}` and `${VAR:-default}` expand in command, args, env, url and headers, as in Claude Code.
 * User and local servers are the user's own config and start; project servers come with the repo
 * and wait for an approval (see `approvals.ts`). `disabledMcpjsonServers` and
 * `disabledMcpServers` keep a server off. Only stdio and streamable HTTP are supported.
 * Tools are named `mcp__<server>__<tool>` (Pi replaces `-` in the server name with `_`).
 */

export type McpScope = "local" | "project" | "user";
export type McpStatus = "start" | "needs-approval" | "disabled" | "unsupported";

export interface CompatMcpServer {
  name: string;
  scope: McpScope;
  /** The file that defined it. */
  source: string;
  status: McpStatus;
  reason?: string;
  warnings: string[];
  /** For Pi, expanded. Undefined when unsupported. */
  config?: McpServerConfig;
  /** Project servers: the approval key and a hash of the definition as written. */
  projectKey?: string;
  fingerprint?: string;
}

export interface LoadMcpOptions {
  cwd: string;
  claude: ClaudeEnv;
  dataDir: string;
}

export interface McpResult {
  servers: CompatMcpServer[];
  errors: string[];
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Claude Code reads these as empty in a remote server's url and headers. */
const CREDENTIAL_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

const readJson = (path: string, errors: string[]): Json | undefined =>
  readJsonOr(path, (m) => errors.push(m));

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

class Expander {
  readonly warnings: string[] = [];
  constructor(
    private readonly env: ClaudeEnv["env"],
    private readonly remote: boolean,
  ) {}

  expand(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, fallback) => {
      if (this.remote && CREDENTIAL_VARS.has(name)) return "";
      const v = this.env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      if (!this.warnings.includes(`${name} is not set`)) this.warnings.push(`${name} is not set`);
      return m;
    });
  }
}

/** Pi expands `$NAME` and runs `!cmd` in env and header values; make ours literal. */
const piLiteral = (value: string) => value.replace(/\$/g, "$$$$").replace(/^!/, "$$!");

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

function convert(
  raw: Json,
  env: ClaudeEnv["env"],
): { config?: McpServerConfig; reason?: string; warnings: string[] } {
  const type = raw.type;
  if (type === "sse" || type === "ws") {
    return { reason: `${type} transport is not supported (stdio and http only)`, warnings: [] };
  }
  if (type === "http" || (type === undefined && typeof raw.url === "string")) {
    if (type === undefined) return { reason: 'a "url" needs "type": "http"', warnings: [] };
    if (typeof raw.url !== "string" || !raw.url) return { reason: "missing url", warnings: [] };
    const x = new Expander(env, true);
    const warnings: string[] = [];
    if (raw.headersHelper !== undefined) {
      warnings.push("headersHelper is not supported; no headers from it");
    }
    const headers = stringMap(raw.headers);
    const config: McpServerConfig = {
      type: "http",
      url: x.expand(raw.url),
      ...(headers
        ? {
            headers: Object.fromEntries(
              Object.entries(headers).map(([k, v]) => [k, piLiteral(x.expand(v))]),
            ),
          }
        : {}),
      exposure: "direct",
    };
    return { config, warnings: [...x.warnings, ...warnings] };
  }
  if (type !== undefined && type !== "stdio") {
    return { reason: `unknown type "${String(type)}"`, warnings: [] };
  }
  if (typeof raw.command !== "string" || !raw.command) {
    return { reason: "missing command", warnings: [] };
  }
  const x = new Expander(env, false);
  const args = Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === "string").map((a) => x.expand(a))
    : undefined;
  const envMap = stringMap(raw.env);
  const config: McpServerConfig = {
    command: x.expand(raw.command),
    ...(args ? { args } : {}),
    ...(envMap
      ? {
          env: Object.fromEntries(
            Object.entries(envMap).map(([k, v]) => [k, piLiteral(x.expand(v))]),
          ),
        }
      : {}),
    exposure: "direct",
  };
  return { config, warnings: x.warnings };
}

function fingerprint(raw: Json, cwd: string): string {
  const { type, command, args, env, url, headers } = raw;
  // The repo script it runs is part of what was approved (V-L6).
  const script =
    typeof command === "string"
      ? scriptRef(command, Array.isArray(args) ? args.map(String) : undefined, cwd)
      : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({ type, command, args, env, url, headers, ...(script ? { script } : {}) }),
    )
    .digest("hex")
    .slice(0, 16);
}

/** The `projects` entry Claude Code keeps for this folder: by cwd, else by repo root. */
function projectEntry(global: Json | undefined, cwd: string): Json | undefined {
  const projects = global?.projects;
  if (!isObject(projects)) return undefined;
  const root = repoRoot(cwd);
  const keys = [cwd, real(cwd), ...(root ? [root, real(root)] : [])];
  for (const key of keys) {
    const entry = projects[key];
    if (isObject(entry)) return entry;
  }
  return undefined;
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadMcpServers(opts: LoadMcpOptions): McpResult {
  const cwd = resolve(opts.cwd);
  const env = opts.claude.env;
  const errors: string[] = [];
  const globalPath = claudeGlobalConfigFile(opts.claude);
  const global = readJson(globalPath, errors);
  const project = projectEntry(global, cwd);

  const root = repoRoot(cwd);
  const mcpJsonDirs = root
    ? ancestorsDown(cwd)
        .filter((d) => d === root || d.startsWith(`${root}/`))
        .reverse()
    : [cwd];

  const settings = claudeSettingsFiles(opts.claude, root ?? cwd);
  const disabledMcpjson = new Set<string>();
  for (const file of Object.values(settings)) {
    for (const n of stringList(readJson(file, errors)?.disabledMcpjsonServers)) {
      disabledMcpjson.add(n);
    }
  }
  for (const n of stringList(project?.disabledMcpjsonServers)) disabledMcpjson.add(n);
  const disabled = new Set(stringList(project?.disabledMcpServers));

  const key = projectKey(cwd);
  const approved = readApprovals(opts.dataDir, cwd);

  // Highest precedence first; the first definition of a name wins.
  const layers: Array<{ scope: McpScope; source: string; servers: unknown }> = [
    { scope: "local", source: globalPath, servers: project?.mcpServers },
    ...mcpJsonDirs.map((d) => {
      const file = join(d, ".mcp.json");
      return {
        scope: "project" as const,
        source: file,
        servers: readJson(file, errors)?.mcpServers,
      };
    }),
    { scope: "user", source: globalPath, servers: global?.mcpServers },
  ];

  const servers: CompatMcpServer[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    if (layer.servers === undefined) continue;
    if (!isObject(layer.servers)) {
      errors.push(`${layer.source}: mcpServers must be an object`);
      continue;
    }
    for (const [name, raw] of Object.entries(layer.servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const base = { name, scope: layer.scope, source: layer.source };
      if (!NAME.test(name)) {
        servers.push({
          ...base,
          status: "unsupported",
          reason: "names may hold only letters, digits, - and _",
          warnings: [],
        });
        continue;
      }
      if (!isObject(raw)) {
        servers.push({ ...base, status: "unsupported", reason: "not an object", warnings: [] });
        continue;
      }
      const { config, reason, warnings } = convert(raw, env);
      if (!config) {
        servers.push({ ...base, status: "unsupported", reason: reason ?? "invalid", warnings });
        continue;
      }
      const server: CompatMcpServer = { ...base, status: "start", warnings, config };
      if (layer.scope === "project") {
        server.projectKey = key;
        server.fingerprint = fingerprint(raw, cwd);
      }
      if (disabled.has(name) || (layer.scope === "project" && disabledMcpjson.has(name))) {
        server.status = "disabled";
        server.reason = "disabled in Claude Code's settings";
      } else if (layer.scope === "project" && approved[name] !== server.fingerprint) {
        server.status = "needs-approval";
        server.reason =
          name in approved
            ? "changed since it was approved; review it, then run `hamness trust`"
            : "a project server; run `hamness trust` to start it";
      }
      servers.push(server);
    }
  }
  return { servers, errors };
}
