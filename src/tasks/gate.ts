/**
 * The proof gate's rule (ADRs 0005, 0012, 0019), pure. A task is verified only when:
 *
 * 1. its latest decided piece of evidence (passed or failed; `error` means nothing was
 *    checked, so it is skipped) passed;
 * 2. its latest decided **strong** piece passed: file evidence the agent wrote itself with
 *    its own write / edit tools is weak and never verifies alone;
 * 3. that strong pass was submitted after the task's last file change through write / edit
 *    (a change still running counts as "now"), so the check saw the final code.
 *
 * Evidence is ordered by when it was submitted: a check that started later saw newer files.
 */

export interface GateEvidence {
  id: string;
  status: "pending" | "passed" | "failed" | "error";
  /** When the claim was submitted, so before the check ran (ms). */
  createdAt: number;
  weak: boolean;
  summary?: string;
}

export type GateResult = { verified: true; reason: string } | { verified: false; reason: string };

export function decideGate(
  evidence: GateEvidence[],
  lastFileChangeAt: number | undefined,
): GateResult {
  const decided = evidence
    .filter((e) => e.status === "passed" || e.status === "failed")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!decided.some((e) => e.status === "passed")) {
    return { verified: false, reason: "no evidence passed" };
  }
  const latest = decided.at(-1) as GateEvidence;
  if (latest.status !== "passed") {
    return {
      verified: false,
      reason: `the latest check failed${latest.summary ? ` (${latest.summary})` : ""}; fix it and prove again`,
    };
  }
  const strong = decided.filter((e) => !e.weak).at(-1);
  if (!strong) {
    return {
      verified: false,
      reason:
        "only weak evidence passed: a file the agent wrote itself proves nothing alone; add a command, URL or CI check",
    };
  }
  if (strong.status !== "passed") {
    return { verified: false, reason: "the latest command, URL or CI check failed" };
  }
  if (lastFileChangeAt !== undefined && strong.createdAt < lastFileChangeAt) {
    return {
      verified: false,
      reason: "files changed after the last passing check; prove again",
    };
  }
  return { verified: true, reason: "the latest checks passed after the last file change" };
}
