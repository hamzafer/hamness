import { expect, test } from "bun:test";
import { PROOF_GATE_PROMPT } from "./tools.ts";

test("the system prompt tells the agent to change files with edit / write, not bash", () => {
  expect(PROOF_GATE_PROMPT).toContain("## Changing files (hamness)");
  expect(PROOF_GATE_PROMPT).toMatch(/edit.*write.*tools/);
  expect(PROOF_GATE_PROMPT).toContain("heredoc");
  expect(PROOF_GATE_PROMPT).toMatch(/bash only to run/);
});
