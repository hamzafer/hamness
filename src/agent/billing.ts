/**
 * How a provider's calls are paid for: `plan` (the ChatGPT plan), `subscription` (another
 * provider's subscription login, never picked by default), or `api` (a pay-per-token key).
 */
export interface Billing {
  kind: "plan" | "subscription" | "api";
  /** For `api`: where the key comes from (an env var name, `key file`, or `stored key`). */
  source?: string;
}

/** True for a call that is paid by a subscription, not per token. */
export const isSubscriptionBilling = (b: Billing | undefined) =>
  b?.kind === "plan" || b?.kind === "subscription";

/** `plan` / `subscription` / `API`, or the long form doctor and the picker use. No imports: the TUI uses it. */
export function billingLabel(b: Billing | undefined, long = false): string {
  if (!b) return long ? "no key or login" : "no key";
  if (b.kind === "plan") return long ? "ChatGPT plan (subscription)" : "plan";
  if (b.kind === "subscription") return long ? "subscription login" : "subscription";
  if (!long) return "API";
  return `API (pay per token${b.source ? `, from ${b.source}` : ""})`;
}
