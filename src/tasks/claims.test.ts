import { describe, expect, test } from "bun:test";
import { parseClaim } from "./claims.ts";

describe("parseClaim", () => {
  test("accepts each kind with its own fields", () => {
    expect(parseClaim({ kind: "command", command: "bun test" })).toEqual({
      ok: true,
      claim: { kind: "command", command: "bun test" },
    });
    expect(parseClaim({ kind: "command", command: "make", timeoutSeconds: 60 })).toEqual({
      ok: true,
      claim: { kind: "command", command: "make", timeoutSeconds: 60 },
    });
    expect(parseClaim({ kind: "file", path: "out/shot.png" })).toMatchObject({ ok: true });
    expect(parseClaim({ kind: "url", url: "http://localhost:3000/health" })).toMatchObject({
      ok: true,
    });
    expect(parseClaim({ kind: "ci", pr: "12" })).toMatchObject({ ok: true });
    expect(parseClaim({ kind: "ci", pr: 12 })).toEqual({ ok: true, claim: { kind: "ci", pr: "12" } });
    expect(
      parseClaim({ kind: "ci", pr: "https://github.com/acme/app/pull/7" }),
    ).toMatchObject({ ok: true });
    expect(parseClaim({ kind: "ci", commit: "abc1234", repo: "acme/app" })).toMatchObject({
      ok: true,
    });
  });

  test("refuses any field that tries to state a result", () => {
    for (const extra of [
      { status: "passed" },
      { passed: true },
      { result: { exitCode: 0 } },
      { exitCode: 0 },
    ]) {
      const parsed = parseClaim({ kind: "command", command: "false", ...extra });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("only hamness's checker");
    }
  });

  test("refuses fields of another kind and missing fields", () => {
    expect(parseClaim({ kind: "file", path: "a", command: "x" }).ok).toBe(false);
    expect(parseClaim({ kind: "command" }).ok).toBe(false);
    expect(parseClaim({ kind: "command", command: "  " }).ok).toBe(false);
    expect(parseClaim({ kind: "shell", command: "x" }).ok).toBe(false);
    expect(parseClaim("bun test").ok).toBe(false);
  });

  test("url must be http or https", () => {
    expect(parseClaim({ kind: "url", url: "file:///etc/passwd" }).ok).toBe(false);
    expect(parseClaim({ kind: "url", url: "not a url" }).ok).toBe(false);
  });

  test("ci needs exactly one of pr or commit, in a shape gh cannot read as a flag", () => {
    expect(parseClaim({ kind: "ci" }).ok).toBe(false);
    expect(parseClaim({ kind: "ci", pr: "1", commit: "abc1234" }).ok).toBe(false);
    expect(parseClaim({ kind: "ci", pr: "--web" }).ok).toBe(false);
    expect(parseClaim({ kind: "ci", commit: "--help" }).ok).toBe(false);
    expect(parseClaim({ kind: "ci", commit: "abc1234", repo: "-R x" }).ok).toBe(false);
  });

  test("timeouts are bounded", () => {
    expect(parseClaim({ kind: "command", command: "x", timeoutSeconds: 0 }).ok).toBe(false);
    expect(parseClaim({ kind: "command", command: "x", timeoutSeconds: 99_999 }).ok).toBe(false);
  });
});
