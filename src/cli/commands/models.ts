import {
  DEFAULT_MODEL,
  listModels,
  type ModelInfo,
  modelInfo,
  parseModelSpec,
  resolveModels,
} from "../../agent/models.ts";
import type { CliContext } from "../run.ts";

const money = (usd: number) => `$${Number(usd.toFixed(4))}`;

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  return `${Math.round(tokens / 1000)}K ctx`;
}

export function formatModel(m: ModelInfo, isDefault: boolean, width: number): string {
  const price = `${money(m.inputPerMTok)} in / ${money(m.outputPerMTok)} out per MTok${m.priced ? "" : " (Pi catalog)"}`;
  return `${isDefault ? "*" : " "} ${m.id.padEnd(width)}  ${m.name}  ${price}  ${contextLabel(m.contextWindow)}`;
}

/** `hamness models [--all]`: the models you can switch to (`/model` in the TUI). */
export async function modelsCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  const all = args.includes("--all");
  if (args.some((a) => a !== "--all")) {
    io.err("Usage: hamness models [--all]");
    return 2;
  }
  let resolved: Awaited<ReturnType<typeof resolveModels>>;
  try {
    resolved = await resolveModels({ dataDir, env });
  } catch (err) {
    io.err(`hamness models: ${(err as Error).message}`);
    return 1;
  }
  const rows = all
    ? resolved.runtime.getModels().map(modelInfo)
    : await listModels(resolved.runtime);
  if (rows.length === 0) {
    io.out(
      "No models available: add a key (`hamness keys set <provider>`) or sign in (`hamness login openai`).",
    );
    return 0;
  }
  const spec = parseModelSpec(env.HAMNESS_MODEL || DEFAULT_MODEL);
  const def = spec ? `${spec.provider}/${spec.id}` : DEFAULT_MODEL;
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const row of rows) io.out(formatModel(row, row.id === def, width));
  io.out("");
  io.out("* is the default for new sessions (HAMNESS_MODEL). Switch in the TUI with /model.");
  return 0;
}
