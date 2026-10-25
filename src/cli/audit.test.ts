import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempHome } from "../../test/support/temp-home.ts";
import { ChatStore } from "../agent/store.ts";
import { dataPaths } from "../config/paths.ts";
import { openDatabase } from "../db/open.ts";
import { DecisionStore } from "../safety/decisions.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let sessions: string[];

beforeEach(() => {
  home = tempHome();
  const db = openDatabase(dataPaths(home.dir).database);
  const chat = new ChatStore(db);
  const decisions = new DecisionStore(db);
  sessions = [];
  for (const cwd of ["/work/a", "/work/b"]) {
    const ids = chat.createSession(cwd, "fake/model");
    sessions.push(ids.sessionId);
    const tc = chat.addToolCall(ids, { messageId: undefined, tool: "bash", argsJson: "{}" });
    decisions.add({
      ...ids,
      toolCallId: tc,
      tool: "bash",
      args: { command: "rm -rf build" },
      verdict: "ask",
      source: "rule",
      reason: 'asked by default rule bash "rm -*r*" for `rm -rf build`',
      rule: "default: bash rm -*r*",
      mode: "auto",
      latencyMs: 1,
    });
    decisions.add({
      ...ids,
      toolCallId: tc,
      tool: "bash",
      args: { command: "rm -rf build" },
      verdict: "deny",
      source: "user",
      reason: "denied by the user",
      mode: "auto",
      latencyMs: 2300,
    });
  }
  db.close();
});
afterEach(() => home.cleanup());

async function audit(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ["audit", ...args],
    { HAMNESS_HOME: home.dir },
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("hamness audit", () => {
  test("lists recent decisions with verdict, source, reason and the call", async () => {
    const r = await audit();
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/TIME.*SESSION.*TOOL.*VERDICT.*SOURCE/);
    expect(r.out).toContain("rm -rf build");
    expect(r.out).toContain("denied by the user");
    expect(r.out).toContain("default: bash rm -*r*");
    expect(r.out).toMatch(/deny\s+user/);
    expect(r.out).toMatch(/ask\s+rule/);
    expect(r.out).toContain("2.3s");
    // Newest first: the second session's answer is on top.
    expect(lines[1]).toContain(sessions[1]?.slice(-8));
  });

  test("--session filters by a session id or its short form, --limit caps the rows", async () => {
    const short = sessions[0]?.slice(-8) as string;
    const r = await audit("--session", short);
    expect(r.out).toContain(short);
    expect(r.out).not.toContain(sessions[1]?.slice(-8));
    const one = await audit("--limit", "1");
    expect(one.out.split("\n").filter((l) => l.includes("bash"))).toHaveLength(1);
  });

  test("--json prints the rows as JSON", async () => {
    const r = await audit("--json", "--limit", "2");
    const rows = JSON.parse(r.out) as Array<{ verdict: string; source: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ verdict: "deny", source: "user" });
  });

  test("bad options are a usage error", async () => {
    expect((await audit("--limit", "zero")).code).toBe(2);
    expect((await audit("--nope")).code).toBe(2);
  });

  test("with no decisions it says so", async () => {
    const empty = tempHome();
    try {
      const out: string[] = [];
      const code = await runCli(
        ["audit"],
        { HAMNESS_HOME: empty.dir },
        { out: (l) => out.push(l), err: () => {} },
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("No decisions");
    } finally {
      empty.cleanup();
    }
  });

  test("--session takes a unique prefix or suffix of the id", async () => {
    const [a, b] = sessions as [string, string];
    const prefix = await audit("--session", a.slice(0, 24));
    expect(prefix.code).toBe(0);
    expect(prefix.out).toContain(a.slice(-8));
    expect(prefix.out).not.toContain(b.slice(-8));
    const suffix = await audit("--session", b.slice(-8));
    expect(suffix.out).toContain(b.slice(-8));
    expect(suffix.out).not.toContain(a.slice(-8));
  });

  test("--session says when nothing matches, or several sessions do", async () => {
    const none = await audit("--session", "zzzzzzzz");
    expect(none.code).toBe(1);
    expect(none.err).toBe("hamness audit: no session matches zzzzzzzz");
    expect(none.out).not.toContain("No decisions");
    const [a, b] = sessions as [string, string];
    let common = 0;
    while (a[common] === b[common]) common++;
    const shared = a.slice(0, Math.max(1, common));
    const several = await audit("--session", shared);
    expect(several.code).toBe(1);
    expect(several.err).toBe(`hamness audit: ${shared} matches several sessions`);
  });

  test("a judge row names the judge model", async () => {
    const db = openDatabase(dataPaths(home.dir).database);
    const chat = new ChatStore(db);
    const ids = chat.createSession("/work/c", "fake/model");
    const tc = chat.addToolCall(ids, { messageId: undefined, tool: "bash", argsJson: "{}" });
    new DecisionStore(db).add({
      ...ids,
      toolCallId: tc,
      tool: "bash",
      args: { command: "bun test" },
      verdict: "allow",
      source: "judge",
      reason: "runs the tests",
      judgeModel: "fake-plan/judge-mini",
      mode: "auto",
      latencyMs: 900,
    });
    db.close();
    const r = await audit("--limit", "1");
    expect(r.out).toContain("runs the tests (judge fake-plan/judge-mini)");
    const json = JSON.parse((await audit("--json", "--limit", "1")).out) as Array<{
      judgeModel: string;
    }>;
    expect(json[0]?.judgeModel).toBe("fake-plan/judge-mini");
  });
});
