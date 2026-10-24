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
    expect(parseClaim({ kind: "ci", pr: 12 })).toEqual({
      ok: true,
      claim: { kind: "ci", pr: "12" },
    });
    expect(parseClaim({ kind: "ci", pr: "https://github.com/acme/app/pull/7" })).toMatchObject({
      ok: true,
    });
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

describe("command evidence must be able to prove something (ADR 0019)", () => {
  const refused = (command: string) => {
    const parsed = parseClaim({ kind: "command", command });
    return parsed.ok ? undefined : parsed.error;
  };

  test("commands that prove nothing are refused, with the reason", () => {
    for (const c of ["true", ":", "exit 0", "echo tests pass", "printf ok", "pwd", "ls -la"]) {
      expect(refused(c)).toContain("proves nothing");
    }
    for (const c of ["cat out.log", "git status", "grep -q PASS log.txt", "cd src && ls"]) {
      expect(refused(c)).toContain("proves nothing");
    }
    // A shell's -c string is looked into.
    expect(refused("sh -c 'exit 0'")).toContain("proves nothing");
  });

  test("operators that hide a failing exit code are refused", () => {
    expect(refused("bun test || true")).toContain("||");
    expect(refused("bun test; echo done")).toContain(";");
    expect(refused("bun test\necho done")).toContain(";");
    expect(refused("bun test &")).toContain("&");
    expect(refused("! bun test")).toContain("!");
    expect(refused("(bun test || exit 0)")).toContain("||");
    expect(refused("bun test && true")).toContain("true");
    expect(refused("set +e && bun test")).toContain("set");
  });

  test("words known only at run time, and info-only flags, are refused", () => {
    expect(refused("bun test $(cat files)")).toContain("run time");
    expect(refused("$RUNNER test")).toContain("run time");
    expect(refused("bun test --help")).toContain("--help");
    expect(refused("pytest --collect-only")).toContain("--collect-only");
    expect(refused("tsc --version")).toContain("--version");
    expect(refused("bun test <<EOF")).toBeDefined();
  });

  test("real checks pass the shape test, including && chains and pipes", () => {
    for (const c of [
      "bun test",
      "cd web && npm test",
      "CI=1 bun test src/tasks",
      "bun test 2>&1 | tail -50",
      "make test && bun run build",
      "cargo test --all",
    ]) {
      expect(refused(c)).toBeUndefined();
    }
  });
});
