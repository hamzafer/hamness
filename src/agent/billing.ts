/** How a provider's calls are paid for: a subscription login, or a pay-per-token API key. */
export interface Billing {
  kind: "plan" | "api";
  /** For `api`: where the key comes from (an env var name, `key file`, or `stored key`). */
  source?: string;
}

/** `plan` / `API`, or the long form doctor and the picker use. No imports: the TUI uses it. */
export function billingLabel(b: Billing | undefined, long = false): string {
  if (!b) return long ? "no key or login" : "no key";
  if (b.kind === "plan") return long ? "ChatGPT plan (subscription)" : "plan";
  if (!long) return "API";
  return `API (pay per token${b.source ? `, from ${b.source}` : ""})`;
}
