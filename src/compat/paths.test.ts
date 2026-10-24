import { describe, expect, test } from "bun:test";
import {
  claudeConfigDir,
  claudeDirOf,
  claudeGlobalConfigFile,
  claudeManagedDir,
  claudeSettingsFiles,
} from "./paths.ts";

const home = "/home/tester";

describe("Claude Code paths", () => {
  test("default to ~/.claude and ~/.claude.json", () => {
    const c = { env: { HOME: home } };
    expect(claudeDirOf(c)).toBe("/home/tester/.claude");
    expect(claudeGlobalConfigFile(c)).toBe("/home/tester/.claude.json");
    expect(claudeSettingsFiles(c, "/work/repo")).toMatchObject({
      user: "/home/tester/.claude/settings.json",
      project: "/work/repo/.claude/settings.json",
      local: "/work/repo/.claude/settings.local.json",
    });
  });

  test("CLAUDE_CONFIG_DIR moves the config dir and .claude.json into it", () => {
    const c = { env: { HOME: home, CLAUDE_CONFIG_DIR: "/accounts/work" } };
    expect(claudeDirOf(c)).toBe("/accounts/work");
    expect(claudeGlobalConfigFile(c)).toBe("/accounts/work/.claude.json");
    expect(claudeSettingsFiles(c, "/w").user).toBe("/accounts/work/settings.json");
  });

  test("managed policy folder per platform", () => {
    expect(claudeManagedDir({ env: {}, platform: "darwin" })).toBe(
      "/Library/Application Support/ClaudeCode",
    );
    expect(claudeManagedDir({ env: {}, platform: "linux" })).toBe("/etc/claude-code");
    expect(claudeManagedDir({ env: {}, platform: "linux", managedDir: "/fx" })).toBe("/fx");
  });

  test("claudeConfigDir is CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg/claude" }, "/home/u")).toBe("/cfg/claude");
    expect(claudeConfigDir({}, "/home/u")).toBe("/home/u/.claude");
  });
});
