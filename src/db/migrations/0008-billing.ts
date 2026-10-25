import type { Migration } from "./types.ts";

/*
 * How a model call was paid for (ADR 0023). `plan`: billed to the user's ChatGPT plan, so
 * `cost_micros` is 0 and stats show "$0 (plan)". NULL: a pay-per-token API call, or a row from
 * before this migration.
 */
const sql = `
ALTER TABLE model_calls ADD COLUMN billing TEXT CHECK (billing IS NULL OR billing IN ('plan', 'api'));
`;

export const modelCallBilling: Migration = { version: 8, name: "model-call-billing", sql };
