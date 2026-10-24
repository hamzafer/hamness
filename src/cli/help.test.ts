import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import type { CliIo } from "./io.ts";
import { COMMAND_NAMES, runCli, USAGE } from "./run.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { cli, out, err, text: () => [...out, ...err].join("\n") };
}

const env = () => ({ HAMNESS_HOME: home.dir });

describe("hamness --help", () => {
  test("lists every command with one line each", () => {
    for (const name of COMMAND_NAMES) {
      expect(USAGE).toMatch(new RegExp(`^  ${name} +\\S.*$`, "m"));
    }
    expect(COMMAND_NAMES).toContain("doctor");
    expect(COMMAND_NAMES).toContain("stop");
  });

  test.each(COMMAND_NAMES.map((n) => [n]))(
    "`hamness %s --help` prints that command's usage and exits 0",
    async (name) => {
      const t = io();
      expect(await runCli([name, "--help"], env(), t.cli)).toBe(0);
      expect(t.out.join("\n")).toContain(`Usage: hamness ${name}`);
      expect(t.err).toEqual([]);
    },
  );

  test("`hamness help <command>` is the same as `<command> --help`", async () => {
    const a = io();
    const b = io();
    await runCli(["help", "stats"], env(), a.cli);
    await runCli(["stats", "--help"], env(), b.cli);
    expect(a.out).toEqual(b.out);
  });
});

describe("errors are one actionable line, not a stack trace", () => {
  test("a corrupt database", async () => {
    writeFileSync(join(home.dir, "hamness.sqlite"), "this is not a database");
    const t = io();
    expect(await runCli(["stats"], env(), t.cli)).toBe(1);
    expect(t.err).toHaveLength(1);
    expect(t.err[0]).toMatch(/^hamness stats: /);
    expect(t.err[0]).toContain("hamness.sqlite");
    expect(t.text()).not.toMatch(/\n\s+at |\| /);
  });

  test("HAMNESS_DEBUG=1 adds the stack for a bug report", async () => {
    writeFileSync(join(home.dir, "hamness.sqlite"), "this is not a database");
    const t = io();
    expect(await runCli(["stats"], { ...env(), HAMNESS_DEBUG: "1" }, t.cli)).toBe(1);
    expect(t.err.length).toBeGreaterThan(1);
  });

  test("the README only documents commands that exist", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
    // Inline `hamness x ...` and shell lines starting with `hamness x` in fenced blocks.
    const inline = [...readme.matchAll(/`hamness ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const fenced = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(/^hamness ([a-z][a-z-]*)/gm)].map((l) => l[1]),
    );
    const used = new Set([...inline, ...fenced] as string[]);
    expect(used.size).toBeGreaterThan(5);
    const known = new Set<string>([...COMMAND_NAMES, "help"]);
    expect([...used].filter((c) => !known.has(c))).toEqual([]);
  });
});
