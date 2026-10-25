import { expect, test } from "bun:test";
import { PROOF_GATE_PROMPT } from "./tools.ts";

test("the system prompt tells the agent to change files with edit / write, not bash", () => {
  expect(PROOF_GATE_PROMPT).toContain("## Changing files (hamness)");
  expect(PROOF_GATE_PROMPT).toMatch(/edit.*write.*tools/);
  expect(PROOF_GATE_PROMPT).toContain("heredoc");
  expect(PROOF_GATE_PROMPT).toMatch(/bash only to run/);
  // True of every mode: the default rules allow some bash writes, so it may (not must) ask.
  expect(PROOF_GATE_PROMPT).toContain("hamness may ask the user");
  expect(PROOF_GATE_PROMPT).not.toContain("every time");
});

test("the system prompt keeps questions out of tasks", () => {
  expect(PROOF_GATE_PROMPT).toMatch(/task_start only for work that changes/);
  expect(PROOF_GATE_PROMPT).toContain(
    "Questions, explanations, reviews and reading the code are not tasks",
  );
});
