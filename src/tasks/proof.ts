import type { HamnessDb } from "../db/open.ts";
import { type CheckContext, runChecker } from "./checkers/index.ts";
import type { TaskStore } from "./store.ts";
import type { CheckResult, EvidenceClaim } from "./types.ts";

/**
 * The one way evidence gets a result (ADR 0005): store the agent's claim as pending, run
 * hamness's checker on it, write what the checker found. This file is the only one that
 * writes `evidence.status` (a test holds that), and nothing here takes a result as input.
 */
export async function proveClaim(
  db: HamnessDb,
  store: TaskStore,
  req: { taskId: string; claim: EvidenceClaim; toolCallId?: string },
  ctx: CheckContext,
  hooks: { onStart?: (evidenceId: string) => void } = {},
): Promise<{ evidenceId: string; result: CheckResult }> {
  const evidenceId = store.addClaim(req.taskId, req.claim, req.toolCallId);
  hooks.onStart?.(evidenceId);
  const result = await runChecker(req.claim, ctx);
  const now = Date.now();
  db.sqlite
    .query(
      `UPDATE evidence SET status = ?, result_json = ?, checked_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(
      result.status,
      JSON.stringify({ summary: result.summary, ...result.details }),
      now,
      now,
      evidenceId,
    );
  return { evidenceId, result };
}
