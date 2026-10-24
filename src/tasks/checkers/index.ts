import type { CheckResult, EvidenceClaim } from "../types.ts";
import { checkCi } from "./ci.ts";
import { checkCommand } from "./command.ts";
import type { CheckContext } from "./context.ts";
import { checkFile } from "./file.ts";
import { checkUrl } from "./url.ts";

export type { CheckContext, GhRunner } from "./context.ts";
export { runGh } from "./ci.ts";

/** Runs the claim's checker. A checker that throws gives an `error` result, never a pass. */
export async function runChecker(claim: EvidenceClaim, ctx: CheckContext): Promise<CheckResult> {
  try {
    switch (claim.kind) {
      case "command":
        return await checkCommand(claim, ctx);
      case "file":
        return await checkFile(claim, ctx);
      case "url":
        return await checkUrl(claim, ctx);
      case "ci":
        return await checkCi(claim, ctx);
    }
  } catch (err) {
    return { status: "error", summary: `checker failed: ${(err as Error).message}`, details: {} };
  }
}
