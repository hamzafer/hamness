import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { ensureDataDir, resolveDataDir } from "./paths.ts";

describe("ensureDataDir", () => {
  const mode = (p: string) => statSync(p).mode & 0o777;

  test("creates the data dir (and parents) owner-only", () => {
    const h = tempHome();
    try {
      const dir = join(h.dir, "a", "hamness");
      ensureDataDir(dir);
      expect(mode(dir)).toBe(0o700);
    } finally {
      h.cleanup();
    }
  });

  test("tightens an existing data dir to 0700", () => {
    const h = tempHome();
    try {
      const dir = join(h.dir, "hamness");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      ensureDataDir(dir);
      expect(mode(dir)).toBe(0o700);
    } finally {
      h.cleanup();
    }
  });
});

const home = "/home/tester";

describe("resolveDataDir", () => {
  test("HAMNESS_HOME wins on any platform", () => {
    expect(resolveDataDir({ HAMNESS_HOME: "/tmp/h" }, "darwin", home)).toBe("/tmp/h");
    expect(resolveDataDir({ HAMNESS_HOME: "/tmp/h" }, "linux", home)).toBe("/tmp/h");
  });

  test("macOS defaults to Application Support", () => {
    expect(resolveDataDir({}, "darwin", "/Users/tester")).toBe(
      "/Users/tester/Library/Application Support/hamness",
    );
  });

  test("Linux uses XDG_DATA_HOME when set", () => {
    expect(resolveDataDir({ XDG_DATA_HOME: "/xdg" }, "linux", home)).toBe("/xdg/hamness");
  });

  test("Linux falls back to ~/.local/share", () => {
    expect(resolveDataDir({}, "linux", home)).toBe("/home/tester/.local/share/hamness");
  });

  test("a relative HAMNESS_HOME resolves against the working directory", () => {
    expect(resolveDataDir({ HAMNESS_HOME: "data" }, "linux", home)).toBe(`${process.cwd()}/data`);
  });

  test("empty HAMNESS_HOME and relative XDG_DATA_HOME are ignored", () => {
    expect(resolveDataDir({ HAMNESS_HOME: "", XDG_DATA_HOME: "rel" }, "linux", home)).toBe(
      "/home/tester/.local/share/hamness",
    );
  });
});
