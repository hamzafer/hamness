import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoRoot } from "../compat/paths.ts";
import { isObject, type Json, readJsonOr } from "../config/json.ts";
import { parseCommand } from "../safety/shell.ts";

/**
 * The script a trusted hook or MCP server runs (V-L6). A hook `sh scripts/check.sh` is only as
 * trusted as `scripts/check.sh`, so when a command's first path argument is a file inside the
 * repo, its content hash joins the item's fingerprint (a missing file counts as missing), and
 * writes to it ask (`referencedScripts`).
 */

/** Interpreters whose first non-flag argument is the script they run. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "tsx",
  "ts-node",
]);
/** `bun run x.ts`, `deno run x.ts`: skip the subcommand. */
const SUBCOMMANDS = new Set(["run"]);

function substitute(s: string, projectDir: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder.
      .replaceAll("${CLAUDE_PROJECT_DIR}", projectDir)
      .replaceAll("$CLAUDE_PROJECT_DIR", projectDir)
  );
}

/** The words a hook or server runs: its exec form, or the first command of its shell string. */
function wordsOf(command: string, args: string[] | undefined, cwd: string): string[] {
  if (args) return [substitute(command, cwd), ...args.map((a) => substitute(a, cwd))];
  const parsed = parseCommand(substitute(command, cwd));
  return parsed.ok ? (parsed.segments[0]?.words ?? []) : [];
}

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** The absolute path of the repo file `command` runs as its script, or undefined. */
export function scriptPath(
  command: string,
  args: string[] | undefined,
  cwd: string,
): string | undefined {
  const words = wordsOf(command, args, cwd);
  const [head = "", ...rest] = words;
  let candidate: string | undefined;
  if (head.includes("/")) candidate = head;
  if (INTERPRETERS.has(basename(head))) {
    const operands = rest.filter((w) => !w.startsWith("-"));
    candidate = SUBCOMMANDS.has(operands[0] ?? "") ? operands[1] : operands[0];
  }
  if (!candidate) return undefined;
  const root = repoRoot(cwd) ?? resolve(cwd);
  const path = resolve(cwd, candidate);
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {}
  return within(path, root) || within(real, realRoot) ? path : undefined;
}

/**
 * What a hook or server's trust covers of its script: the path relative to the repo's top
 * (so a worktree's copy matches its main repo's) and its sha256, or null when it is missing.
 */
export function scriptRef(
  command: string,
  args: string[] | undefined,
  cwd: string,
): { script: string; sha256: string | null } | undefined {
  const path = scriptPath(command, args, cwd);
  if (!path) return undefined;
  const root = repoRoot(cwd) ?? resolve(cwd);
  let sha256: string | null = null;
  try {
    sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {}
  return { script: relative(root, path), sha256 };
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String) : undefined;

/**
 * Every repo script a project hook or project MCP server in `cwd` runs, as absolute paths:
 * writes to them ask (V-L6), like writes to the settings that name them.
 */
export function referencedScripts(cwd: string): string[] {
  const root = repoRoot(cwd) ?? resolve(cwd);
  const here = resolve(cwd);
  const dirs = [...new Set([root, here])];
  const out = new Set<string>();
  const add = (command: unknown, args: unknown) => {
    if (typeof command !== "string") return;
    const p = scriptPath(command, strings(args), cwd);
    if (p) out.add(p);
  };
  for (const d of dirs) {
    for (const f of ["settings.json", "settings.local.json"]) {
      const hooks = readJsonOr(join(d, ".claude", f), () => {})?.hooks;
      if (!isObject(hooks)) continue;
      for (const groups of Object.values(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups as Json[]) {
          if (!isObject(g) || !Array.isArray(g.hooks)) continue;
          for (const h of g.hooks as Json[]) if (isObject(h)) add(h.command, h.args);
        }
      }
    }
  }
  // `.mcp.json` from the repo root down to the cwd, as Claude Code reads them.
  for (let d = here; ; d = resolve(d, "..")) {
    const servers = readJsonOr(join(d, ".mcp.json"), () => {})?.mcpServers;
    if (isObject(servers)) {
      for (const s of Object.values(servers)) if (isObject(s)) add(s.command, s.args);
    }
    if (d === root || resolve(d, "..") === d || !within(d, root)) break;
  }
  return [...out];
}
