import { projectKey } from "../compat/paths.ts";
import { type Json, readJson, writeJsonAtomic } from "../config/json.ts";
import { isTrusted, proofItem } from "../trust/index.ts";
import { projectConfigPath, userConfigPath } from "./config.ts";
import { matchCommand } from "./glob.ts";
import { type EvalContext, evaluate, PROVE_COMMAND, type Rule } from "./rules.ts";

/**
 * The safety side of the proof gate (ADR 0019).
 *
 * A `prove` command re-run (tool `prove_command`) answers two questions:
 * - **may it run?** Exactly what a `bash` call with that command would get: the rules (user
 *   and trusted project allow rules included), then the judge in auto mode, then the user;
 *   yolo runs it. Being on the proof list never lets a command run.
 * - **does it count?** Only when every part is on the **proof command list** (or is a
 *   built-in read-only helper such as `cd` or `tail`); anything else asks the user whether it
 *   counts as proof, in every mode (the judge never decides it, and yolo does not skip it).
 *
 * The list: built-in test runners, builds, linters and typecheckers, then the user config's
 * `proof.commands`, then the project's `.hamness/config.json` `proof.commands` when the repo
 * is trusted. Patterns are bash command globs (`make check *`). "Allow always" adds to the
 * user's list, never the project's.
 *
 * ```json
 * { "proof": { "commands": ["make verify *"], "allowPrivateUrls": false } }
 * ```
 */

export { PROVE_COMMAND, PROVE_URL } from "./rules.ts";

export interface ProofPattern {
  pattern: string;
  layer: "default" | "user" | "project";
}

export interface ProofConfig {
  commands: ProofPattern[];
  /** User config only: let `prove url` reach loopback, private and link-local addresses. */
  allowPrivateUrls: boolean;
}

const runScripts = "{test,build,lint,typecheck,check}{,\\:*}";

/** Test runners, builds, linters and typecheckers. A trailing ` *` also matches no arguments. */
export const DEFAULT_PROOF_COMMANDS: readonly string[] = [
  "bun test *",
  `bun run ${runScripts} *`,
  "npm test *",
  "npm t *",
  `npm run ${runScripts} *`,
  "pnpm test *",
  `pnpm run ${runScripts} *`,
  `pnpm ${runScripts} *`,
  "yarn test *",
  `yarn run ${runScripts} *`,
  `yarn ${runScripts} *`,
  "deno {test,check,lint} *",
  "cargo {test,build,check,clippy,nextest} *",
  "go {test,build,vet} *",
  "pytest *",
  "python -m pytest *",
  "python3 -m pytest *",
  "uv run pytest *",
  "make {test,check,build,lint}{,-*} *",
  "tsc *",
  "{npx,bunx,pnpm exec} tsc *",
  "biome {check,lint,ci} *",
  "{npx,bunx} biome {check,lint,ci} *",
  "eslint *",
  "{npx,bunx} eslint *",
  "ruff check *",
  "mypy *",
  "gradle test *",
  "./gradlew {test,build,check} *",
  "mvn {test,verify} *",
  "dotnet {test,build} *",
  "swift {test,build} *",
  "mix test *",
];

/** Read-only commands that may sit next to a check (`cd web && npm test`, `| tail`). */
const HELPERS = ["cd *", "pushd *", "popd *"];

function proofBlock(path: string, file: Json | undefined): Json {
  const block = file?.proof;
  if (block === undefined) return {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${path}: "proof" must be an object`);
  }
  return block as Json;
}

function commandsOf(path: string, block: Json): string[] {
  const list = block.commands;
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((c) => typeof c === "string" && c.trim())) {
    throw new Error(`${path}: proof.commands must be a list of command patterns`);
  }
  return list.map((c: string) => c.trim());
}

/**
 * The proof config for a session in `cwd`. Each project command counts only once the user
 * trusted it for the repo (`hamness trust`, ADR 0020); untrusted ones are left out.
 */
export function loadProofConfig(dataDir: string, cwd: string): ProofConfig {
  const userPath = userConfigPath(dataDir);
  const user = proofBlock(userPath, readJson(userPath));
  const allow = user.allowPrivateUrls ?? false;
  if (typeof allow !== "boolean") {
    throw new Error(`${userPath}: proof.allowPrivateUrls must be true or false`);
  }
  const commands: ProofPattern[] = [
    ...DEFAULT_PROOF_COMMANDS.map((pattern) => ({ pattern, layer: "default" as const })),
    ...commandsOf(userPath, user).map((pattern) => ({ pattern, layer: "user" as const })),
  ];
  const projectPath = projectConfigPath(cwd);
  const project = proofBlock(projectPath, readJson(projectPath));
  const key = projectKey(cwd);
  for (const pattern of commandsOf(projectPath, project)) {
    if (isTrusted(dataDir, key, "safety", proofItem(pattern))) {
      commands.push({ pattern, layer: "project" });
    }
  }
  return { commands, allowPrivateUrls: allow };
}

/** Adds patterns to the user config's `proof.commands` ("allow always" on a proof question). */
export function addUserProofCommands(dataDir: string, patterns: string[]): string {
  const path = userConfigPath(dataDir);
  const file = readJson(path) ?? {};
  const proof = { ...proofBlock(path, file) };
  const list = commandsOf(path, proof);
  for (const p of patterns) if (!list.includes(p)) list.push(p);
  proof.commands = list;
  file.proof = proof;
  writeJsonAtomic(path, file, 0o600);
  return path;
}

const isBashRule = (r: Rule) => matchCommand(r.tool, "bash");

export interface ProofListing {
  /** Every part is on the proof list or is a read-only helper. */
  listed: boolean;
  /** Why it is not listed (empty when listed). */
  reason: string;
  /** What "allow always" adds to the user's proof list (tool `prove_command`). */
  suggestions: Rule[];
}

/**
 * Whether a proof re-run counts as evidence (ADR 0019): every part of the command is on the
 * proof list, or is a read-only helper (`cd`, the built-in read-only bash commands). This says
 * nothing about whether it may run: that is the bash decision (rules, judge, user).
 */
export function proofListing(
  command: string,
  rules: Rule[],
  proof: ProofPattern[],
  ctx: EvalContext,
): ProofListing {
  const listed: Rule[] = [
    ...rules.filter((r) => isBashRule(r) && r.verdict === "allow" && r.layer === "default"),
    ...HELPERS.map((pattern) => ({
      tool: "bash",
      pattern,
      verdict: "allow" as const,
      layer: "default" as const,
    })),
    ...proof.map((p) => ({
      tool: "bash",
      pattern: p.pattern,
      verdict: "allow" as const,
      layer: p.layer,
    })),
  ];
  const evaluation = evaluate({ tool: "bash", args: { command } }, listed, ctx);
  if (evaluation.verdict === "allow") return { listed: true, reason: "", suggestions: [] };
  return {
    listed: false,
    reason: `count \`${command}\` as proof? It is not on the proof command list (${evaluation.reason})`,
    suggestions: evaluation.suggestions.map((s) => ({ ...s, tool: PROVE_COMMAND })),
  };
}
