import { isSubscriptionBilling } from "../../agent/billing.ts";
import {
  billingLabel,
  listModels,
  loadModels,
  type ModelInfo,
  modelInfo,
  modelName,
} from "../../agent/models.ts";
import type { CliContext } from "../run.ts";

export const MODELS_USAGE = [
  "Usage: hamness models [--all]",
  "",
  "Lists the models you have a login or key for, ChatGPT plan models first; * marks the default.",
  "  --all  The whole catalog, keyed or not",
].join("\n");

const money = (usd: number) => `$${Number(usd.toFixed(4))}`;

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  return `${Math.round(tokens / 1000)}K ctx`;
}

/** A plan model's calls cost $0; an API model shows its per-token price and where the key is. */
export function priceText(m: ModelInfo): string {
  if (isSubscriptionBilling(m.billing)) return `$0 (${billingLabel(m.billing)})`;
  const price = `${money(m.inputPerMTok)} in / ${money(m.outputPerMTok)} out per MTok${m.priced ? "" : " (Pi catalog)"}`;
  return m.billing ? `${price} · ${billingLabel(m.billing, true)}` : price;
}

export function formatModel(m: ModelInfo, isDefault: boolean, width: number): string {
  return `${isDefault ? "*" : " "} ${m.id.padEnd(width)}  ${m.name}  ${priceText(m)}  ${contextLabel(m.contextWindow)}`;
}

/** `hamness models [--all]`: the models you can switch to (`/model` in the TUI). */
export async function modelsCommand({ args, env, dataDir, io }: CliContext): Promise<number> {
  const all = args.includes("--all");
  if (args.some((a) => a !== "--all")) {
    io.err(MODELS_USAGE);
    return 2;
  }
  let loaded: Awaited<ReturnType<typeof loadModels>>;
  try {
    loaded = await loadModels({ dataDir, env });
  } catch (err) {
    io.err(`hamness models: ${(err as Error).message}`);
    return 1;
  }
  const rows = all
    ? loaded.runtime.getModels().map((m) => modelInfo(m, loaded.billing(m.provider)))
    : await listModels(loaded.runtime, loaded.billing, loaded.planTier);
  if (rows.length === 0) {
    io.out(
      "No models available: sign in with your ChatGPT plan (`hamness login openai`). Optional: `hamness keys set <provider>` for pay-per-token API models.",
    );
    return 0;
  }
  const def = loaded.model ? modelName(loaded.model) : undefined;
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const row of rows) io.out(formatModel(row, row.id === def, width));
  io.out("");
  io.out(
    def
      ? "* is the default for new sessions (HAMNESS_MODEL or defaultModel override it). Switch in the TUI with /model."
      : "No default yet: `hamness login openai` signs in with your ChatGPT plan.",
  );
  return 0;
}
