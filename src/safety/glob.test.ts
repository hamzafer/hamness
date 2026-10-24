import { describe, expect, test } from "bun:test";
import { matchCommand, matchPath } from "./glob.ts";

describe("command patterns", () => {
  test("* matches anything, spaces and slashes included", () => {
    expect(matchCommand("git status*", "git status --short")).toBe(true);
    expect(matchCommand("cat *", "cat src/a.ts b.ts")).toBe(true);
    expect(matchCommand("cat *", "head a.ts")).toBe(false);
  });

  test("a trailing ' *' also matches the bare command", () => {
    expect(matchCommand("ls *", "ls")).toBe(true);
    expect(matchCommand("ls *", "lsof")).toBe(false);
  });

  test("{a,b} alternation and ? for one character", () => {
    expect(matchCommand("{sudo,doas} *", "doas rm x")).toBe(true);
    expect(matchCommand("rm -?f x", "rm -rf x")).toBe(true);
  });

  test("a backslash makes the next character literal", () => {
    expect(matchCommand("rm -rf /\\*", "rm -rf /*")).toBe(true);
    expect(matchCommand("rm -rf /\\*", "rm -rf /tmp")).toBe(false);
  });

  test("regex characters in a pattern are literal", () => {
    expect(matchCommand("echo (a)+.", "echo (a)+.")).toBe(true);
    expect(matchCommand("echo a.c", "echo abc")).toBe(false);
  });
});

describe("path patterns", () => {
  test("* stays inside one segment, ** crosses them", () => {
    expect(matchPath("/w/*.ts", "/w/a.ts")).toBe(true);
    expect(matchPath("/w/*.ts", "/w/src/a.ts")).toBe(false);
    expect(matchPath("/w/**", "/w/src/a.ts")).toBe(true);
    expect(matchPath("/w/**/*.ts", "/w/a.ts")).toBe(true);
  });

  test("**/name matches the name in any folder, dotfiles included", () => {
    expect(matchPath("**/.env", "/w/.env")).toBe(true);
    expect(matchPath("**/.env", "/w/deep/x/.env")).toBe(true);
    expect(matchPath("**/.env", "/w/.envrc")).toBe(false);
    expect(matchPath("**", "/anything/at/all")).toBe(true);
  });

  test("braces, including an empty choice", () => {
    expect(matchPath("/h/.ssh{,/**}", "/h/.ssh")).toBe(true);
    expect(matchPath("/h/.ssh{,/**}", "/h/.ssh/id_rsa")).toBe(true);
    expect(matchPath("/h/.ssh{,/**}", "/h/.sshx")).toBe(false);
  });
});
