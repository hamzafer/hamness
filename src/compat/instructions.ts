import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  ancestorsDown,
  type ClaudeEnv,
  claudeConfigDir,
  claudeManagedDir,
  homeOf,
  repoRoot,
} from "./paths.ts";

/**
 * Claude Code's instruction files, found the way Claude Code finds them at launch
 * (https://code.claude.com/docs/en/memory):
 *
 * 1. managed `CLAUDE.md` (organization policy)
 * 2. user: `<config dir>/CLAUDE.md`, then `<config dir>/rules/**\/*.md`
 * 3. every folder from the filesystem root down to the cwd: `CLAUDE.md`, `.claude/CLAUDE.md`,
 *    `.claude/rules/**\/*.md`, then `CLAUDE.local.md`
 * 4. `AGENTS.md` and `.claude/AGENTS.md` per folder, by default only when no folder at or above
 *    the cwd has a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`.
 *
 * `@path` imports expand in place (four hops at most, never inside code). A project file can't
 * import from outside the project: Claude Code asks first, hamness skips it and says so.
 * Not done: folders below the cwd and path-scoped rules, which Claude Code loads lazily.
 */

export type InstructionScope = "managed" | "user" | "project" | "local";

export interface InstructionFile {
  path: string;
  scope: InstructionScope;
  /** After imports are expanded and block HTML comments stripped. */
  content: string;
  /** Files pulled in with `@path`, in the order they expanded. */
  imports: string[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** Claude Code's "Project instructions" setting. */
export type InstructionMode =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";

const MODES: readonly InstructionMode[] = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
];

export interface InstructionsResult {
  files: InstructionFile[];
  skipped: SkippedFile[];
  mode: InstructionMode;
}

export interface FindInstructionsOptions {
  cwd: string;
  claude: ClaudeEnv;
}

const MAX_IMPORT_HOPS = 4;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read from user and managed settings only, like Claude Code (project settings can't set it). */
function instructionMode(claude: ClaudeEnv): InstructionMode {
  const managed = claudeManagedDir(claude);
  const files = [
    join(claudeConfigDir(claude), "settings.json"),
    ...(managed ? [join(managed, "managed-settings.json")] : []),
  ];
  let mode: InstructionMode = "claude-md-or-agents-md";
  for (const file of files) {
    const configs = readJson(file)?.pluginConfigs as Record<string, unknown> | undefined;
    for (const id of ["agents-md@builtin", "cc-plugin-agents-md@builtin"]) {
      const value = (configs?.[id] as { options?: { instructionFiles?: unknown } } | undefined)
        ?.options?.instructionFiles;
      if (typeof value === "string" && (MODES as readonly string[]).includes(value)) {
        mode = value as InstructionMode;
      }
    }
  }
  return mode;
}

/** `.md` files under a rules folder, recursively, sorted by path. */
function ruleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string) => {
    const r = real(d);
    if (seen.has(r)) return; // a symlink loop
    seen.add(r);
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && name.endsWith(".md")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const FENCE = /^\s*(```|~~~)/;
const IMPORT = /(^|[\s(])@((?:\\ |[^\s`"'()])+)/g;

/** Hides inline code spans (same length) so imports inside them are not seen. */
function maskCode(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
}

class Loader {
  readonly files: InstructionFile[] = [];
  readonly skipped: SkippedFile[] = [];
  private readonly loaded = new Set<string>();

  constructor(
    private readonly home: string,
    /** Imports from project files must stay under this folder. */
    private readonly projectRoot: string,
  ) {}

  has(path: string): boolean {
    return this.loaded.has(real(path));
  }

  /** Loads a file once (by real path). Returns false when it isn't there. */
  add(path: string, scope: InstructionScope, rule = false): boolean {
    if (!isFile(path)) return false;
    const key = real(path);
    if (this.loaded.has(key)) return true;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.skipped.push({ path, reason: `unreadable: ${(err as Error).message}` });
      return true;
    }
    if (rule) {
      let fm: Record<string, unknown> = {};
      try {
        ({ frontmatter: fm, body: text } = parseFrontmatter(text));
      } catch {
        // Bad YAML: Claude Code loads the rule with no fields.
      }
      if (fm.paths !== undefined) {
        this.skipped.push({
          path,
          reason: "path-scoped rule: Claude Code loads it only when matching files are touched",
        });
        return true;
      }
    }
    this.loaded.add(key);
    const imports: string[] = [];
    const content = this.expand(text, path, scope, 0, [key], imports);
    this.files.push({ path, scope, content: content.trim(), imports });
    return true;
  }

  private expand(
    text: string,
    file: string,
    scope: InstructionScope,
    depth: number,
    chain: string[],
    imports: string[],
  ): string {
    const out: string[] = [];
    let fence: string | undefined;
    let inComment = false;
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && f[1] === fence) fence = undefined;
        out.push(line);
        continue;
      }
      if (inComment) {
        const end = line.indexOf("-->");
        if (end < 0) continue;
        inComment = false;
        const rest = line.slice(end + 3);
        if (rest.trim()) out.push(rest);
        continue;
      }
      if (f) {
        fence = f[1];
        out.push(line);
        continue;
      }
      if (line.trimStart().startsWith("<!--")) {
        const start = line.indexOf("<!--");
        const end = line.indexOf("-->", start + 4);
        if (end < 0) {
          inComment = true;
          continue;
        }
        const rest = line.slice(end + 3);
        if (rest.trim()) out.push(rest);
        continue;
      }
      out.push(this.expandLine(line, file, scope, depth, chain, imports));
    }
    return out.join("\n");
  }

  private expandLine(
    line: string,
    file: string,
    scope: InstructionScope,
    depth: number,
    chain: string[],
    imports: string[],
  ): string {
    const masked = maskCode(line);
    let result = "";
    let last = 0;
    for (const m of masked.matchAll(IMPORT)) {
      const raw = m[2] ?? "";
      const start = (m.index ?? 0) + (m[1]?.length ?? 0);
      const target = this.importTarget(raw, file);
      if (!target) continue;
      const { path, token } = target;
      const key = real(path);
      if (depth + 1 > MAX_IMPORT_HOPS || chain.includes(key)) continue;
      if (scope === "project" || scope === "local") {
        const rel = relative(this.projectRoot, key);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          this.skipped.push({
            path,
            reason: `import from outside the project (in ${file}); Claude Code asks before loading these`,
          });
          continue;
        }
      }
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      imports.push(path);
      this.loaded.add(key);
      const expanded = this.expand(body, path, scope, depth + 1, [...chain, key], imports).trim();
      result += line.slice(last, start) + expanded;
      last = start + 1 + token.length;
    }
    return result + line.slice(last);
  }

  /** The file an `@token` names, trying the token as written, then without trailing punctuation. */
  private importTarget(raw: string, file: string): { path: string; token: string } | undefined {
    const candidates = [raw];
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    if (trimmed && trimmed !== raw) candidates.push(trimmed);
    for (const token of candidates) {
      const p = token.replace(/\\ /g, " ");
      const path =
        p === "~" || p.startsWith("~/")
          ? join(this.home, p.slice(1))
          : isAbsolute(p)
            ? p
            : resolve(dirname(file), p);
      if (isFile(path)) return { path, token };
    }
    return undefined;
  }
}

export function findInstructions(opts: FindInstructionsOptions): InstructionsResult {
  const { claude } = opts;
  const cwd = resolve(opts.cwd);
  const mode = instructionMode(claude);
  const loader = new Loader(homeOf(claude), real(repoRoot(cwd) ?? cwd));

  const managed = claudeManagedDir(claude);
  if (managed) loader.add(join(managed, "CLAUDE.md"), "managed");
  if (mode === "managed-only") return { files: loader.files, skipped: loader.skipped, mode };

  const userDir = claudeConfigDir(claude);
  loader.add(join(userDir, "CLAUDE.md"), "user");
  for (const rule of ruleFiles(join(userDir, "rules"))) loader.add(rule, "user", true);

  const dirs = ancestorsDown(cwd);
  const claudeFiles = (dir: string) => [
    join(dir, "CLAUDE.md"),
    join(dir, ".claude", "CLAUDE.md"),
    join(dir, "CLAUDE.local.md"),
  ];
  const anyClaudeFile = dirs.some((d) => claudeFiles(d).some(isFile));
  const agents =
    mode === "claude-md-and-agents-md" || (mode === "claude-md-or-agents-md" && !anyClaudeFile);

  for (const dir of dirs) {
    const [main, dotClaude, local] = claudeFiles(dir) as [string, string, string];
    loader.add(main, "project");
    loader.add(dotClaude, "project");
    for (const rule of ruleFiles(join(dir, ".claude", "rules"))) loader.add(rule, "project", true);
    loader.add(local, "local");
    if (agents) {
      for (const file of [join(dir, "AGENTS.md"), join(dir, ".claude", "AGENTS.md")]) {
        if (!loader.has(file)) loader.add(file, "project");
      }
    }
  }
  return { files: loader.files, skipped: loader.skipped, mode };
}
