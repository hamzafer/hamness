import type { Migration } from "./types.ts";

/*
 * `decisions.judge_model`: the model a judge decision came from (`provider/id`), so
 * `hamness audit` can name it. NULL for every other source and for rows from before this.
 */
const sql = `
ALTER TABLE decisions ADD COLUMN judge_model TEXT;
`;

export const decisionJudgeModel: Migration = { version: 11, name: "decision-judge-model", sql };
