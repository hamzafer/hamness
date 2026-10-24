import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { ChatStore } from "../agent/store.ts";
import { openDatabase } from "../db/open.ts";
import { caseInsensitiveAt, createSafetyService, listFiles } from "./service.ts";

let tmp: ReturnType<typeof tempHome>;
let home: string;
let cwd: string;
let check: (command: string) => Promise<boolean>;
let call: (tool: string, args: Record<string, unknown>) => Promise<boolean>;

beforeEach(() => {
  tmp = tempHome();
  home = realpathSync(tmp.dir);
  cwd = join(home, "proj");
  const dataDir = join(home, "data");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  mkdirSync(dataDir);
  writeFileSync(join(home, ".ssh", "id_rsa"), "k");
  writeFileSync(join(cwd, ".env"), "S=1");
  writeFileSync(join(cwd, "a.ts"), "");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ safety: { mode: "ask" } }));
  const db = openDatabase(join(dataDir, "hamness.sqlite"));
  const store = new ChatStore(db);
  const { sessionId, agentId } = store.createSession(cwd, "anthropic/x");
  const safety = createSafetyService({ db, dataDir, home });
  call = async (tool, args) => {
    const toolCallId = store.addToolCall(
      { sessionId, agentId, taskId: undefined },
      { messageId: undefined, tool, argsJson: "{}" },
    );
    const v = await safety.check({ sessionId, toolCallId, tool, args, cwd });
    return v.allow;
  };
  check = (command) => call("bash", { command });
});
afterEach(() => tmp.cleanup());

describe("the safety service expands shell globs against the disk (S-M1)", () => {
  test("a glob that matches a secret is denied; one over plain files is allowed", async () => {
    expect(await check("cat ~/.ss?/id_rsa")).toBe(false);
    expect(await check("cat .en?")).toBe(false);
    expect(await check("cat *.ts")).toBe(true);
  });
});

describe("the doom loop (S-L3)", () => {
  test("the same command with other spacing is the same call", async () => {
    expect(await check("ls -la")).toBe(true);
    expect(await check("ls  -la ")).toBe(true);
    expect(await check("ls\t-la")).toBe(false);
  });

  test("the same args in another key order are the same call", async () => {
    expect(await call("write", { path: "a.ts", content: "x" })).toBe(true);
    expect(await call("write", { content: "x", path: "a.ts" })).toBe(true);
    expect(await call("write", { path: "a.ts", content: "x" })).toBe(false);
  });
});

describe("a proof re-run gets the same run decision as bash, plus the proof list (V-H1)", () => {
  type Asked = { reason: string; suggestions: Array<{ tool: string; pattern: string }> };
  async function prove(
    command: string,
    opts: {
      config?: Record<string, unknown>;
      judge?: "allow" | "ask";
      answer?: "allow-once" | "allow-always" | "deny";
    } = {},
  ) {
    const dataDir = join(home, "data");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(opts.config ?? {}));
    const db = openDatabase(join(dataDir, "proof.sqlite"));
    const store = new ChatStore(db);
    const { sessionId, agentId } = store.createSession(cwd, "anthropic/x");
    const judged: string[] = [];
    const safety = createSafetyService({
      db,
      dataDir,
      home,
      ...(opts.judge
        ? {
            judge: async (req) => {
              judged.push(req.tool);
              return { verdict: opts.judge as "allow" | "ask", reason: "judged" };
            },
          }
        : {}),
    });
    const asked: Asked[] = [];
    const toolCallId = store.addToolCall(
      { sessionId, agentId, taskId: undefined },
      { messageId: undefined, tool: "prove", argsJson: "{}" },
    );
    const v = await safety.check(
      { sessionId, toolCallId, tool: "prove_command", args: { command }, cwd },
      {
        cwd,
        askUser: async (req) => {
          asked.push({ reason: req.reason, suggestions: req.suggestions });
          return { decision: opts.answer ?? "deny", by: "user" };
        },
      },
    );
    db.close();
    return { allow: v.allow, asked, judged };
  }

  test("a listed check no bash rule allows asks to run in ask mode", async () => {
    const r = await prove("bun test --bail", { config: { safety: { mode: "ask" } } });
    expect(r.allow).toBe(false);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.reason).not.toContain("as proof?");
  });

  test("a listed check a bash allow rule allows runs without asking", async () => {
    const config = { safety: { mode: "ask", permission: { bash: { "bun test *": "allow" } } } };
    const r = await prove("bun test --bail", { config });
    expect(r).toMatchObject({ allow: true, asked: [] });
  });

  test("in auto mode the judge decides whether a listed check may run", async () => {
    const yes = await prove("bun test", { config: { safety: { mode: "auto" } }, judge: "allow" });
    expect(yes).toMatchObject({ allow: true, asked: [], judged: ["bash"] });
    const no = await prove("bun test", { config: { safety: { mode: "auto" } }, judge: "ask" });
    expect(no.allow).toBe(false);
    expect(no.asked).toHaveLength(1);
  });

  test("allowed to run but not on the list asks whether it counts as proof, in every mode", async () => {
    const judged = await prove("mkdir made", {
      config: { safety: { mode: "auto" } },
      judge: "allow",
    });
    expect(judged.asked[0]?.reason).toContain("count `mkdir made` as proof?");
    const ruled = await prove("mkdir made", {
      config: { safety: { mode: "ask", permission: { bash: { "mkdir *": "allow" } } } },
    });
    expect(ruled.asked[0]?.reason).toContain("as proof?");
    const yolo = await prove("mkdir made", { config: { safety: { mode: "yolo" } } });
    expect(yolo.asked[0]?.reason).toContain("as proof?");
  });

  test("yolo runs a listed check without asking", async () => {
    const r = await prove("bun test", { config: { safety: { mode: "yolo" } } });
    expect(r).toMatchObject({ allow: true, asked: [] });
  });

  test("bash denies still apply, in yolo too", async () => {
    const r = await prove("sudo bun test", { config: { safety: { mode: "yolo" } } });
    expect(r).toMatchObject({ allow: false, asked: [] });
  });

  test("one question when neither the rules nor the list decide; allow always saves both", async () => {
    const r = await prove("mkdir -p made", {
      config: { safety: { mode: "ask" } },
      answer: "allow-always",
    });
    expect(r.allow).toBe(true);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.reason).toContain("as proof?");
    expect(r.asked[0]?.suggestions).toEqual([
      { tool: "bash", pattern: "mkdir *" },
      { tool: "prove_command", pattern: "mkdir *" },
    ]);
    const user = JSON.parse(readFileSync(join(home, "data", "config.json"), "utf8"));
    expect(user.proof.commands).toEqual(["mkdir *"]);
    const project = JSON.parse(readFileSync(join(cwd, ".hamness", "config.json"), "utf8"));
    expect(project.safety.permission.bash).toEqual({ "mkdir *": "allow" });
  });
});

describe("the service detects a case-insensitive filesystem (V-M4)", () => {
  test("detection agrees with the disk, and protected paths follow it", async () => {
    writeFileSync(join(cwd, "probe.txt"), "x");
    let insensitive = false;
    try {
      insensitive = realpathSync(join(cwd, "PROBE.TXT")) !== "";
    } catch {}
    expect(caseInsensitiveAt(cwd)).toBe(insensitive);
    expect(await call("write", { path: ".MCP.json", content: "{}" })).toBe(!insensitive);
    expect(await call("write", { path: ".mcp.json", content: "{}" })).toBe(false);
  });
});

describe("recursive reads are checked against the files on disk (V-M5)", () => {
  test("grep -r over a folder with .env asks; one over plain files is allowed", async () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "x");
    expect(await check("grep -rn TODO src")).toBe(true);
    expect(await check("grep -r SECRET .")).toBe(false);
    expect(await check("rg -uu SECRET")).toBe(false);
    expect(await call("grep", { pattern: "SECRET", path: "src" })).toBe(true);
    expect(await call("grep", { pattern: "SECRET" })).toBe(false);
  });

  test("Pi's grep honours .gitignore, so an ignored .env is not read (when rg is installed)", async () => {
    writeFileSync(join(cwd, ".gitignore"), ".env\n");
    expect(await call("grep", { pattern: "SECRET" })).toBe(Bun.which("rg") !== null);
    expect(await check("grep -r SECRET .")).toBe(false);
  });
});

describe("listing files without ripgrep (V-M5)", () => {
  test("every file is listed, dot files only when hidden ones count", () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "x");
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(listFiles(cwd, { ignore: true, hidden: true })?.sort()).toEqual(
        [join(cwd, ".env"), join(cwd, "a.ts"), join(cwd, "src", "a.ts")].sort(),
      );
      expect(listFiles(cwd, { ignore: true, hidden: false })?.sort()).toEqual(
        [join(cwd, "a.ts"), join(cwd, "src", "a.ts")].sort(),
      );
    } finally {
      process.env.PATH = path;
    }
  });
});
