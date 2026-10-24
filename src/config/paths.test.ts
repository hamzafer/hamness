import { describe, expect, test } from "bun:test";
import { resolveDataDir } from "./paths.ts";

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
