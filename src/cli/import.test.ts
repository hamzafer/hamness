import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  claudeAssistant,
  claudeSessionPath,
  codexMeta,
  codexSessionPath,
  codexTokenCount,
  writeLines,
} from "../../test/support/history.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { openDatabase } from "../db/open.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

beforeEach(() => {
  home = tempHome();
  out = [];
  err = [];
});
afterEach(() => home.cleanup());

const env = (extra: Record<string, string> = {}) => ({
  HAMNESS_HOME: join(home.dir, "data"),
  HOME: join(home.dir, "home"),
  ...extra,
});

function seed(claudeDir: string, codexDir: string) {
  const sid = "99999999-9999-4999-8999-999999999999";
  writeLines(claudeSessionPath(claudeDir, sid), [
    claudeAssistant(sid, "2026-03-01T10:00:01.000Z", { id: "m1", usage: { output: 5 } }),
  ]);
  const thread = "019a0000-0000-7000-8000-00000000000a";
  writeLines(codexSessionPath(codexDir, thread), [
    codexMeta(thread, "2026-03-04T10:00:00.000Z"),
    codexTokenCount("2026-03-04T10:00:01.000Z", { input: 1, output: 1 }, { input: 1, output: 1 }),
  ]);
}

function sessionSources() {
  const db = openDatabase(join(home.dir, "data", "hamness.sqlite"));
  try {
    return db.sqlite
      .query<{ source: string }, []>("SELECT source FROM sessions ORDER BY source")
      .all()
      .map((r) => r.source);
  } finally {
    db.close();
  }
}

describe("hamness import", () => {
  test("reads ~/.claude and ~/.codex by default", async () => {
    seed(join(home.dir, "home", ".claude"), join(home.dir, "home", ".codex"));

    const code = await runCli(["import"], env(), io);

    expect(code).toBe(0);
    expect(sessionSources()).toEqual(["claude-code", "codex"]);
    expect(out.join("\n")).toContain("2 sessions");
  });

  test("takes several --claude-dir flags and a --codex-dir", async () => {
    const a = join(home.dir, "a");
    const b = join(home.dir, "b");
    seed(a, join(home.dir, "cx"));
    writeLines(claudeSessionPath(b, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), [
      claudeAssistant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-03-02T10:00:00.000Z", {
        id: "m9",
      }),
    ]);

    const code = await runCli(
      ["import", "--claude-dir", a, "--claude-dir", b, "--codex-dir", join(home.dir, "cx")],
      env(),
      io,
    );

    expect(code).toBe(0);
    expect(sessionSources()).toEqual(["claude-code", "claude-code", "codex"]);
  });

  test("with no history anywhere it says so and succeeds", async () => {
    mkdirSync(join(home.dir, "home"), { recursive: true });
    const code = await runCli(["import"], env(), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("No Claude Code or Codex history found");
  });

  test("a flag pointing nowhere is an error", async () => {
    const code = await runCli(["import", "--codex-dir", join(home.dir, "nope")], env(), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("not a directory");
  });

  test("an unknown option is a usage error", async () => {
    const code = await runCli(["import", "--frob"], env(), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Usage: hamness import");
  });
});
