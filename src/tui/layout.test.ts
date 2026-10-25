import { describe, expect, test } from "bun:test";
import {
  headerParts,
  PROMPT_HINTS,
  plural,
  promptHint,
  shortPath,
  welcomeLine,
  wrappedRows,
} from "./layout.ts";
import { statusRows } from "./status-panel.tsx";

describe("headerParts", () => {
  const input = {
    name: "e2e-calc",
    cwd: "/home/user/developer/ai/playground/proj",
    home: "/home/user",
    model: "openai-codex/gpt-6.1-sol",
    billing: "plan",
    judge: { text: "judge on", warn: false },
    busy: true,
  };
  const text = (width: number, over = {}) =>
    headerParts({ ...input, ...over }, width)
      .map((p) => p.text)
      .join("");

  test("everything shows when there is room", () => {
    expect(text(120)).toBe(
      "hamness · e2e-calc · ~/developer/ai/playground/proj · openai-codex/gpt-6.1-sol · plan · judge on · working…",
    );
  });

  test("short of room the folder shrinks, then goes, then the judge, the billing, the provider", () => {
    expect(text(90)).toBe(
      "hamness · e2e-calc · ~/…/proj · openai-codex/gpt-6.1-sol · plan · judge on · working…",
    );
    expect(text(70)).toBe("hamness · e2e-calc · openai-codex/gpt-6.1-sol · plan · working…");
    expect(text(56)).toBe("hamness · e2e-calc · openai-codex/gpt-6.1-sol · working…");
    expect(text(46)).toBe("hamness · e2e-calc · gpt-6.1-sol · working…");
    expect(text(35)).toBe("hamness · gpt-6.1-sol · working…");
    expect(text(32)).toBe("hamness · gpt-6.1-sol · working…");
    // Then `working…` (the rail shows the run), and last the model is cut.
    expect(text(26)).toBe("hamness · gpt-6.1-sol");
    expect(text(16)).toBe("hamness · gpt-6…");
  });

  test("it never runs past its width", () => {
    for (let w = 1; w <= 130; w++) expect(text(w).length).toBeLessThanOrEqual(w);
    for (let w = 1; w <= 130; w++) {
      expect(text(w, { name: "a very long session name indeed" }).length).toBeLessThanOrEqual(w);
    }
  });
});

describe("plural", () => {
  test("one of a thing is singular, any other count plural", () => {
    expect(plural(1, "prompt")).toBe("1 prompt");
    expect(plural(0, "prompt")).toBe("0 prompts");
    expect(plural(2, "reply", "replies")).toBe("2 replies");
    expect(plural(1, "reply", "replies")).toBe("1 reply");
  });

  test("/status counts read right for one of each", () => {
    const rows = statusRows(
      {
        sessionId: "s-1",
        cwd: "/work/demo",
        model: "fake/m",
        thinkingLevel: "off",
        busy: false,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        costMicros: 0,
        messages: { user: 1, assistant: 1, toolCalls: 1 },
        task: {
          id: "t1",
          goal: "g",
          implicit: false,
          outcome: "open",
          evidence: 1,
          passed: 1,
          costMicros: 0,
          tokens: 0,
          startedAt: 0,
          durationMs: 0,
        },
      },
      HOME,
    );
    const row = (k: string) => rows.find(([key]) => key === k)?.[1];
    expect(row("Messages")).toBe("1 prompt, 1 assistant message, 1 tool call");
    expect(row("Task")).toBe("g · open · 1/1 check");
  });
});

describe("welcomeLine", () => {
  test("folder, model and the hint when they fit; parts drop, never the hint, when they don't", () => {
    const model = "anthropic/claude-opus-5-5";
    expect(welcomeLine("/home/user/dev/app", HOME, model, 100)).toBe(
      `~/dev/app · ${model} · Type / for commands`,
    );
    for (const width of [20, 30, 40, 46, 60]) {
      const line = welcomeLine("/home/user/dev/projects/some-app", HOME, model, width);
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).toContain("Type / for commands");
    }
    expect(welcomeLine("/home/user/dev/app", HOME, model, 46)).toContain("claude-opus-5-5");
  });
});

describe("wrappedRows", () => {
  test("counts the rows text takes when wrapped at word breaks", () => {
    expect(wrappedRows("", 10)).toBe(1);
    expect(wrappedRows("short", 10)).toBe(1);
    expect(wrappedRows("one\ntwo\n", 10)).toBe(3);
    expect(wrappedRows("aaaa bbbb cccc", 10)).toBe(2);
    expect(wrappedRows("aaaa bbbbb", 10)).toBe(1);
    // A word longer than the row breaks inside it.
    expect(wrappedRows("x".repeat(25), 10)).toBe(3);
    // Wide characters take two columns each.
    expect(wrappedRows("日本語の文", 10)).toBe(1);
    expect(wrappedRows("日本語の文章です", 10)).toBe(2);
    expect(wrappedRows("日本 語の文章", 10)).toBe(2);
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
