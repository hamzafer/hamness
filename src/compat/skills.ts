import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { ancestorsDown, type ClaudeEnv, claudeDirOf, repoRoot } from "./paths.ts";

/**
 * Skills in Claude Code's format (`<folder>/<name>/SKILL.md` with YAML frontmatter,
 * https://code.claude.com/docs/en/skills), from Claude Code's folders and hamness's own.
 * Only names and descriptions go in the system prompt; the `skill` tool loads a body on demand.
 *
 * Folders, first one wins a name clash (personal over project, as in Claude Code):
 * 1. `<Claude config dir>/skills` and `<hamness data dir>/skills` (user)
 * 2. `.claude/skills` in the cwd and each folder above it up to the repo root, nearest first,
 *    then `<repo root>/.hamness/skills` (project)
 *
 * Skill text is instructions, not code: hamness never runs a skill's `` !`cmd` `` lines, and
 * fields that would change permissions or the model (`allowed-tools`, `model`, ...) are read
 * but not honored. They are listed in `ignoredFields` so `hamness compat` can say so.
 */

export interface CompatSkill {
  name: string;
  description: string;
  whenToUse?: string;
  filePath: string;
  baseDir: string;
  scope: "user" | "project";
  /** `disable-model-invocation`: only the user may run it, so it is not listed for the model. */
  disableModelInvocation: boolean;
  /** `user-invocable`: whether it shows in a user's skill menu. */
  userInvocable: boolean;
  /** Names from `arguments`, for `$name` placeholders. */
  argumentNames: string[];
  ignoredFields: string[];
}

export interface DiscoverSkillsOptions {
  cwd: string;
  claude: ClaudeEnv;
  /** hamness's data dir; its `skills` folder holds hamness-only skills. */
  dataDir: string;
}

export interface SkillsResult {
  skills: CompatSkill[];
  skipped: Array<{ path: string; reason: string }>;
}

const IGNORED = [
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
];

/** Claude Code's listing cap for description plus when_to_use. */
const LISTING_MAX = 1536;

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  return fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Frontmatter and body. Bad YAML loads the skill with no fields, as Claude Code does. */
function parse(text: string): { fm: Record<string, unknown>; body: string } {
  try {
    const { frontmatter, body } = parseFrontmatter(text);
    return { fm: frontmatter, body };
  } catch {
    const normalized = text.replace(/\r\n?/g, "\n");
    const end = normalized.indexOf("\n---", 3);
    return { fm: {}, body: end < 0 ? normalized : normalized.slice(end + 4).trim() };
  }
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

function loadSkill(file: string, scope: CompatSkill["scope"]): CompatSkill {
  const { fm, body } = parse(readFileSync(file, "utf8"));
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  const whenToUse = str(fm.when_to_use);
  return {
    name: str(fm.name) ?? basename(dirname(file)),
    description: str(fm.description) ?? firstLine ?? "",
    ...(whenToUse ? { whenToUse } : {}),
    filePath: file,
    baseDir: dirname(file),
    scope,
    disableModelInvocation: bool(fm["disable-model-invocation"], false),
    userInvocable: bool(fm["user-invocable"], true),
    argumentNames: names(fm.arguments),
    ignoredFields: IGNORED.filter((k) => fm[k] !== undefined),
  };
}

export function discoverSkills(opts: DiscoverSkillsOptions): SkillsResult {
  const cwd = resolve(opts.cwd);
  const root = repoRoot(cwd);
  const projectDirs = root
    ? ancestorsDown(cwd)
        .filter((d) => d === root || d.startsWith(`${root}/`))
        .reverse()
    : [cwd];
  const folders: Array<[string, CompatSkill["scope"]]> = [
    [join(claudeDirOf(opts.claude), "skills"), "user"],
    [join(opts.dataDir, "skills"), "user"],
    ...projectDirs.map((d): [string, CompatSkill["scope"]] => [
      join(d, ".claude", "skills"),
      "project",
    ]),
    ...(root
      ? [[join(root, ".hamness", "skills"), "project"] as [string, CompatSkill["scope"]]]
      : []),
  ];

  const skills: CompatSkill[] = [];
  const skipped: SkillsResult["skipped"] = [];
  const byName = new Set<string>();
  const seen = new Set<string>();
  for (const [folder, scope] of folders) {
    let entries: string[];
    try {
      entries = readdirSync(folder).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const file = join(folder, entry, "SKILL.md");
      let key: string;
      try {
        if (!statSync(file).isFile()) continue;
        key = realpathSync(file);
      } catch {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      let skill: CompatSkill;
      try {
        skill = loadSkill(file, scope);
      } catch (err) {
        skipped.push({ path: file, reason: `unreadable: ${(err as Error).message}` });
        continue;
      }
      if (byName.has(skill.name)) {
        skipped.push({ path: file, reason: `another skill named "${skill.name}" comes first` });
        continue;
      }
      byName.add(skill.name);
      skills.push(skill);
    }
  }
  return { skills, skipped };
}

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** The system prompt section: one entry per skill the model may run. Empty with none. */
export function skillsPrompt(skills: CompatSkill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "When a task matches a skill's description, load its instructions with the `skill` tool (name, and optional arguments) before acting.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    let text = s.whenToUse ? `${s.description} ${s.whenToUse}` : s.description;
    if (text.length > LISTING_MAX) text = `${text.slice(0, LISTING_MAX - 1)}…`;
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(s.name)}</name>`,
      `    <description>${escapeXml(text)}</description>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Splits arguments like a shell: spaces separate, quotes group. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export interface RenderOptions {
  args?: string;
  projectDir: string;
  sessionId?: string;
}

/** A skill's body for the model, with Claude Code's placeholders filled in. */
export function renderSkill(skill: CompatSkill, opts: RenderOptions): string {
  const { body } = parse(readFileSync(skill.filePath, "utf8"));
  const args = (opts.args ?? "").trim();
  const positional = splitArgs(args);
  const named = new Map(skill.argumentNames.map((n, i) => [n, positional[i] ?? ""]));
  let usedArgs = false;

  let text = body
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.baseDir)
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, opts.projectDir)
    .replace(/\$\{CLAUDE_SESSION_ID\}/g, opts.sessionId ?? "");
  text = text.replace(
    /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_][\w-]*)/g,
    (m, i, n, name) => {
      if (i !== undefined || n !== undefined) {
        usedArgs = true;
        return positional[Number(i ?? n)] ?? "";
      }
      if (name !== undefined) {
        if (!named.has(name)) return m;
        usedArgs = true;
        return named.get(name) ?? "";
      }
      usedArgs = true;
      return args;
    },
  );
  if (args && !usedArgs) text = `${text}\n\nARGUMENTS: ${args}`;
  return `Base directory for this skill: ${skill.baseDir}\n\n${text}`;
}
