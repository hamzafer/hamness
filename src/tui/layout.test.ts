import { describe, expect, test } from "bun:test";
import { PROMPT_HINTS, promptHint, shortPath, wrappedRows } from "./layout.ts";

describe("wrappedRows", () => {
  test("counts the rows text takes when wrapped at word breaks", () => {
    expect(wrappedRows("", 10)).toBe(1);
    expect(wrappedRows("short", 10)).toBe(1);
    expect(wrappedRows("one\ntwo\n", 10)).toBe(3);
    expect(wrappedRows("aaaa bbbb cccc", 10)).toBe(2);
    expect(wrappedRows("aaaa bbbbb", 10)).toBe(1);
    // A word longer than the row breaks inside it.
    expect(wrappedRows("x".repeat(25), 10)).toBe(3);
  });
});

const HOME = "/home/user";

describe("shortPath", () => {
  test("home becomes ~, and a path that fits is kept whole", () => {
    expect(shortPath("/home/user/dev/project", HOME, 40)).toBe("~/dev/project");
    expect(shortPath("/home/user", HOME, 40)).toBe("~");
    expect(shortPath("/srv/app", HOME, 40)).toBe("/srv/app");
    expect(shortPath("/", HOME, 40)).toBe("/");
    // Only a whole folder name counts as home.
    expect(shortPath("/home/username/x", HOME, 40)).toBe("/home/username/x");
  });

  test("a long path elides the middle and keeps the last folder name whole", () => {
    const path = "/home/user/developer/ai/playground/claude-code-mods";
    expect(shortPath(path, HOME, 33)).toBe("~/…/playground/claude-code-mods");
    expect(shortPath(path, HOME, 24)).toBe("~/…/claude-code-mods");
    expect(shortPath("/srv/a/b/c/deep-folder", HOME, 18)).toBe("/srv/…/deep-folder");
  });

  test("when even that is too long, the last folder name is still whole", () => {
    const path = "/home/user/developer/claude-code-mods";
    expect(shortPath(path, HOME, 18)).toBe("…/claude-code-mods");
    expect(shortPath(path, HOME, 5)).toBe("claude-code-mods");
  });
});

describe("promptHint", () => {
  test("the longest hint that fits, never one cut mid-sentence", () => {
    expect(promptHint(200)).toBe(PROMPT_HINTS[0] ?? "");
    for (const width of [20, 40, 64, 80, 120]) {
      const hint = promptHint(width);
      expect(PROMPT_HINTS).toContain(hint);
      expect(hint.length <= width || hint === PROMPT_HINTS.at(-1)).toBe(true);
    }
    expect(promptHint(64).length).toBeGreaterThan(promptHint(20).length);
  });
});
