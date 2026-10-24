import { expect, test } from "bun:test";
import { claudeConfigDir } from "./paths.ts";

test("Claude Code's config dir is CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg/claude" }, "/home/u")).toBe("/cfg/claude");
  expect(claudeConfigDir({}, "/home/u")).toBe("/home/u/.claude");
});
