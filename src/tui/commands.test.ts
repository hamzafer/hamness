import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  findCommand,
  matchCommands,
  menuQuery,
  parseExportArgs,
  parseSlash,
  relativeTime,
} from "./commands.ts";

const names = (q: string) => matchCommands(q).map((m) => m.label);

describe("the command registry", () => {
  test("every command has a unique name and alias, and a sentence-case description", () => {
    const seen = new Set<string>();
    for (const c of COMMANDS) {
      for (const n of [c.name, ...(c.aliases ?? [])]) {
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }
      expect(c.description).toMatch(/^[A-Z]/);
      expect(c.description).not.toMatch(/\.$/);
    }
    for (const n of [
      "new",
      "clear",
      "compact",
      "resume",
      "sessions",
      "fork",
      "status",
      "cost",
      "thinking",
      "model",
      "mode",
      "name",
      "copy",
      "export",
      "skills",
      "mcp",
      "exit",
      "quit",
      "task",
      "override",
      "abandon",
      "judge",
      "help",
    ]) {
      expect(seen.has(n)).toBe(true);
    }
  });

  test("findCommand knows names and aliases", () => {
    expect(findCommand("clear")?.name).toBe("new");
    expect(findCommand("quit")?.name).toBe("exit");
    expect(findCommand("sessions")?.name).toBe("resume");
    expect(findCommand("cost")?.name).toBe("status");
    expect(findCommand("?")?.name).toBe("help");
    expect(findCommand("nope")).toBeUndefined();
  });
});

describe("the / menu's filter", () => {
  test("a bare / lists every command once, by name, in registry order", () => {
    expect(names("")).toEqual(COMMANDS.map((c) => `/${c.name}`));
  });

  test("exact and prefix matches come first, then fuzzy ones", () => {
    expect(names("new")[0]).toBe("/new");
    expect(names("co").slice(0, 2)).toEqual(["/compact", "/copy"]);
    expect(names("cmp")).toContain("/compact");
    expect(names("ex").slice(0, 2)).toEqual(["/export", "/exit"]);
    expect(names("exp")[0]).toBe("/export");
  });

  test("an alias match shows the alias the user is typing", () => {
    expect(names("cle")[0]).toBe("/clear");
    expect(matchCommands("cle")[0]?.command.name).toBe("new");
    expect(names("qu")[0]).toBe("/quit");
  });

  test("no match is an empty list", () => {
    expect(names("zzz")).toEqual([]);
  });

  test("the menu shows only while the first word is being typed", () => {
    expect(menuQuery("/")).toBe("");
    expect(menuQuery("/com")).toBe("com");
    expect(menuQuery("/compact ")).toBeUndefined();
    expect(menuQuery("hello")).toBeUndefined();
    expect(menuQuery(" /x")).toBeUndefined();
    expect(menuQuery("/a\nb")).toBeUndefined();
  });
});

describe("parseSlash", () => {
  test("a known command with its argument", () => {
    const p = parseSlash("/compact  keep the plan ");
    expect(p && "command" in p ? [p.command.name, p.arg] : p).toEqual(["compact", "keep the plan"]);
    const alias = parseSlash("/clear");
    expect(alias && "command" in alias ? alias.command.name : alias).toBe("new");
    const help = parseSlash("/?");
    expect(help && "command" in help ? help.command.name : help).toBe("help");
  });

  test("an unknown word is a typo; a path or plain text is a prompt", () => {
    expect(parseSlash("/frobnicate now")).toEqual({ unknown: "/frobnicate" });
    expect(parseSlash("/work/demo/notes.txt what is in it?")).toBeUndefined();
    expect(parseSlash("fix the bug")).toBeUndefined();
  });
});

describe("helpers", () => {
  test("parseExportArgs: format first, then an optional path", () => {
    expect(parseExportArgs("")).toEqual({ format: "html" });
    expect(parseExportArgs("jsonl")).toEqual({ format: "jsonl" });
    expect(parseExportArgs("html out/s.html")).toEqual({ format: "html", path: "out/s.html" });
    expect(parseExportArgs("notes.jsonl")).toEqual({ format: "jsonl", path: "notes.jsonl" });
    expect(parseExportArgs("notes.html")).toEqual({ format: "html", path: "notes.html" });
  });

  test("relativeTime reads like a person would say it", () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
  });
});
