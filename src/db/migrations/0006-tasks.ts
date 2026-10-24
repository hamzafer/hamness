import type { Migration } from "./types.ts";

/*
 * Tasks and the proof gate (ticket #6, ADRs 0004, 0005, 0012).
 *
 * - `tasks.outcome_reason`: the user's reason for an override or abandon.
 * - `evidence.tool_call_id`: the `prove` tool call that submitted the claim.
 * - Triggers that hold the gate in the database itself, whatever code (or an agent running
 *   `sqlite3` on the file) writes: evidence enters as a pending claim, gets one result with its
 *   `result_json`, and is then final; a task becomes `verified` only with passing evidence,
 *   and a closed outcome is final except `unverified` -> `overridden`.
 *   Fixtures may still insert closed tasks directly (the gate is on the close, an UPDATE).
 */
const sql = `
ALTER TABLE tasks ADD COLUMN outcome_reason TEXT;
ALTER TABLE evidence ADD COLUMN tool_call_id TEXT REFERENCES tool_calls (id);
CREATE INDEX evidence_tool_call ON evidence (tool_call_id);

CREATE TRIGGER evidence_claim_only BEFORE INSERT ON evidence
WHEN NEW.status != 'pending' OR NEW.result_json IS NOT NULL OR NEW.checked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'evidence starts as a pending claim; only a checker writes its result');
END;

CREATE TRIGGER evidence_claim_fixed BEFORE UPDATE ON evidence
WHEN NEW.claim_json IS NOT OLD.claim_json OR NEW.kind IS NOT OLD.kind
  OR NEW.task_id IS NOT OLD.task_id OR NEW.tool_call_id IS NOT OLD.tool_call_id
BEGIN
  SELECT RAISE(ABORT, 'an evidence claim cannot change after it is submitted');
END;

CREATE TRIGGER evidence_result_final BEFORE UPDATE ON evidence
WHEN OLD.status != 'pending' AND (NEW.status IS NOT OLD.status
  OR NEW.result_json IS NOT OLD.result_json OR NEW.checked_at IS NOT OLD.checked_at)
BEGIN
  SELECT RAISE(ABORT, 'evidence results are final');
END;

CREATE TRIGGER evidence_result_complete BEFORE UPDATE ON evidence
WHEN NEW.status != 'pending' AND (NEW.result_json IS NULL OR NEW.checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'an evidence result needs result_json and checked_at');
END;

CREATE TRIGGER tasks_outcome_final BEFORE UPDATE OF outcome ON tasks
WHEN OLD.outcome != 'open' AND NEW.outcome IS NOT OLD.outcome
  AND NOT (OLD.outcome = 'unverified' AND NEW.outcome = 'overridden')
BEGIN
  SELECT RAISE(ABORT, 'a closed task outcome is final (only unverified can be overridden)');
END;

CREATE TRIGGER tasks_proof_gate BEFORE UPDATE OF outcome ON tasks
WHEN NEW.outcome = 'verified' AND NEW.outcome IS NOT OLD.outcome
  AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.task_id = NEW.id AND e.status = 'passed')
BEGIN
  SELECT RAISE(ABORT, 'proof gate: verified needs at least one passed piece of evidence');
END;
`;

export const tasksAndProof: Migration = { version: 6, name: "tasks-and-proof", sql };
