import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectConfigPath, userConfigPath } from "./config.ts";
import { matchCommand } from "./glob.ts";
import { type EvalContext, type Evaluation, evaluate, type Rule } from "./rules.ts";

/**
 * The safety side of the proof gate (ADR 0019).
 *
 * A `prove` command re-run is checked as its own tool, `prove_command`, not as `bash`:
 * - bash deny and ask rules still apply to every part of the command;
 * - bash allow rules from the user or the project do not: "safe to run" is not "proof";
 * - it runs without asking only when every part is on the **proof command list** (or is a
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

export const PROVE_COMMAND = "prove_command";
export const PROVE_URL = "prove_url";

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

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: must hold a JSON object`);
  }
  return parsed as Json;
}

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
 * The proof config for a session in `cwd`. Project commands count only when
 * `projectTrusted` says the repo is trusted; they are ignored (not an error) otherwise.
 */
export function loadProofConfig(
  dataDir: string,
  cwd: string,
  opts: { projectTrusted?: boolean } = {},
): ProofConfig {
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
  if (opts.projectTrusted) {
    const projectPath = projectConfigPath(cwd);
    const project = proofBlock(projectPath, readJson(projectPath));
    commands.push(
      ...commandsOf(projectPath, project).map((pattern) => ({
        pattern,
        layer: "project" as const,
      })),
    );
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

const isBashRule = (r: Rule) => matchCommand(r.tool, "bash");

/**
 * The rules for a proof re-run: helpers and the proof list first (so any later ask or deny
 * wins), then every rule except bash allows from the user and the project. The built-in
 * read-only bash allows stay, as harmless helpers: none of them is a check on its own, and the
 * claim parser refuses a command made only of them.
 */
export function evaluateProofCommand(
  command: string,
  rules: Rule[],
  proof: ProofPattern[],
  ctx: EvalContext,
): Evaluation {
  const listed: Rule[] = [
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
  const kept = rules.filter(
    (r) => !(isBashRule(r) && r.verdict === "allow" && r.layer !== "default"),
  );
  const evaluation = evaluate({ tool: "bash", args: { command } }, [...listed, ...kept], ctx);
  const suggestions = evaluation.suggestions.map((s) => ({ ...s, tool: PROVE_COMMAND }));
  if (evaluation.verdict !== "undecided") return { ...evaluation, suggestions };
  return {
    ...evaluation,
    reason: `count \`${command}\` as proof? It is not on the proof command list (${evaluation.reason})`,
    suggestions,
  };
}
