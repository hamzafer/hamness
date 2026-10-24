import type { CheckContext } from "../../src/tasks/checkers/context.ts";

/** A checker context with nothing reachable: no gh, no network, everything allowed. */
export function checkContext(cwd: string, over: Partial<CheckContext> = {}): CheckContext {
  return {
    sessionId: "s-test",
    cwd,
    toolCallId: "tc-test",
    taskStartedAt: Date.now() - 1000,
    safety: async () => ({ allow: true }),
    gh: async () => {
      throw new Error("gh is not available in tests");
    },
    fetch: async () => {
      throw new Error("the network is not available in tests");
    },
    ...over,
  };
}
