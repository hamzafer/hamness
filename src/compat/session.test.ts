// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax is the fixture.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FakeModel, fakeModel } from "../../test/support/fake-model.ts";
import { snapshotTree, writeTree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import {
  type AgentRunner,
  type RunnerEvent,
  startAgentRunner,
  type ToolGuard,
} from "../agent/runner.ts";
import { approveProjectServers, loadCompat } from "./index.ts";

/** A session built from fixture Claude Code folders: instructions, skills and MCP end to end. */

const SERVER = resolve(import.meta.dir, "../../test/support/mcp-server.ts");

let tmp: ReturnType<typeof tempHome>;
let home: string;
let repo: string;
let dataDir: string;
let log: string;
let fake: FakeModel;
let runner: AgentRunner | undefined;
let events: RunnerEvent[];

beforeEach(async () => {
  tmp = tempHome();
  home = join(tmp.dir, "home");
  repo = join(tmp.dir, "repo");
  dataDir = join(tmp.dir, "data");
  log = join(tmp.dir, "mcp-calls.log");
  writeTree(tmp.dir, { "repo/.git/HEAD": "", "home/.keep": "" });
  fake = await fakeModel(tmp.dir);
  events = [];
});
afterEach(() => {
  runner?.dispose();
  runner = undefined;
  tmp.cleanup();
});

const env = (extra: Record<string, string> = {}) => ({ HOME: home, ...extra });
const json = (v: unknown) => JSON.stringify(v, null, 2);
const echoServer = (extraEnv: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [SERVER],
  env: { MCP_TEST_LOG: log, ...extraEnv },
});

async function start(guard?: ToolGuard, extraEnv: Record<string, string> = {}) {
  const compat = loadCompat({
    cwd: repo,
    dataDir,
    claude: { env: env(extraEnv), managedDir: join(tmp.dir, "managed") },
  });
  runner = await startAgentRunner({
    cwd: repo,
    agentDir: join(dataDir, "pi"),
    models: fake,
    onEvent: (e) => events.push(e),
    compat,
    ...(guard ? { guard } : {}),
  });
  return runner;
}

const ofType = <T extends RunnerEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === type);
/** The system message Pi sent on call `i` (its sections, as JSON text). */
const systemPrompt = (i = 0) =>
  JSON.stringify(
    (fake.contexts[i]?.messages as Array<{ role: string }> | undefined)?.find(
      (m) => m.role === "system",
    ) ?? "",
  );
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

describe("a session with Claude Code's setup", () => {
  test("instruction files go into the system prompt in Claude Code's order", async () => {
    writeTree(tmp.dir, {
      "home/.claude/CLAUDE.md": "USER-RULE-1",
      "repo/CLAUDE.md": "REPO-RULE-2",
      "repo/CLAUDE.local.md": "LOCAL-RULE-3",
      "repo/AGENTS.md": "AGENTS-NOT-LOADED",
    });
    fake.script([{ text: "ok" }]);
    await (await start()).prompt("hi");
    const sp = systemPrompt();
    expect(sp).toContain("USER-RULE-1");
    expect(sp.indexOf("USER-RULE-1")).toBeLessThan(sp.indexOf("REPO-RULE-2"));
    expect(sp.indexOf("REPO-RULE-2")).toBeLessThan(sp.indexOf("LOCAL-RULE-3"));
    expect(sp).not.toContain("AGENTS-NOT-LOADED");
  });

  test("skills are listed by description and their body loads through the skill tool", async () => {
    writeTree(tmp.dir, {
      "home/.claude/skills/greet/SKILL.md":
        "---\ndescription: Greets people politely.\n---\nSay GREETING-BODY to $ARGUMENTS.\n",
    });
    fake.script([
      { text: "Loading.", tools: [{ name: "skill", args: { name: "greet", arguments: "Ada" } }] },
      { text: "Done." },
    ]);
    const seen: string[] = [];
    await (
      await start(async (c) => {
        seen.push(c.tool);
        return { allow: true };
      })
    ).prompt("greet Ada");

    expect(systemPrompt(0)).toContain("Greets people politely.");
    expect(systemPrompt(0)).not.toContain("GREETING-BODY");
    expect(seen).toEqual(["skill"]);
    const [end] = ofType("tool.end");
    expect(end?.isError).toBe(false);
    expect(JSON.stringify(fake.contexts[1])).toContain("Say GREETING-BODY to Ada.");
  });

  test("a user-level MCP server's tool is callable, through the guard", async () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({
        mcpServers: { test: echoServer({ ECHO_SUFFIX: "${SUFFIX}" }) },
      }),
    });
    fake.script([
      { text: "Echoing.", tools: [{ name: "mcp__test__echo", args: { text: "hi" } }] },
      { text: "Done." },
    ]);
    const seen: string[] = [];
    const r = await start(
      async (c) => {
        seen.push(`${c.tool} ${JSON.stringify(c.args)}`);
        return { allow: true };
      },
      { SUFFIX: "!" },
    );
    await r.prompt("echo hi");

    expect(seen).toEqual(['mcp__test__echo {"text":"hi"}']);
    const [end] = ofType("tool.end");
    expect(end).toMatchObject({ isError: false, summary: "echo: hi!" });
    expect(calls()).toBe("echo hi\n");
  });

  test("a denied MCP call never reaches the server", async () => {
    writeTree(tmp.dir, { "home/.claude.json": json({ mcpServers: { test: echoServer() } }) });
    fake.script([
      { text: "Echoing.", tools: [{ name: "mcp__test__echo", args: { text: "hi" } }] },
      { text: "Blocked." },
    ]);
    await (await start(async () => ({ allow: false, reason: "no" }))).prompt("echo");
    expect(ofType("tool.denied")).toHaveLength(1);
    expect(calls()).toBe("");
  });

  test("a project .mcp.json server starts only once the repo is approved", async () => {
    writeTree(tmp.dir, { "repo/.mcp.json": json({ mcpServers: { proj: echoServer() } }) });
    fake.script([
      { text: "Trying.", tools: [{ name: "mcp__proj__echo", args: { text: "a" } }] },
      { text: "No such tool." },
    ]);
    await (await start()).prompt("echo");
    expect(ofType("tool.end")[0]?.isError).toBe(true);
    expect(calls()).toBe("");
    runner?.dispose();
    events = [];

    approveProjectServers(
      dataDir,
      loadCompat({
        cwd: repo,
        dataDir,
        claude: { env: env(), managedDir: join(tmp.dir, "managed") },
      }).mcp.servers,
    );
    fake.script([
      { text: "Trying.", tools: [{ name: "mcp__proj__echo", args: { text: "b" } }] },
      { text: "Done." },
    ]);
    await (await start()).prompt("echo");
    expect(ofType("tool.end")[0]).toMatchObject({ isError: false, summary: "echo: b" });
    expect(calls()).toBe("echo b\n");
  });

  test("never writes to Claude Code's files", async () => {
    writeTree(tmp.dir, {
      "home/.claude/CLAUDE.md": "rules",
      "home/.claude/settings.json": json({ disabledMcpjsonServers: [] }),
      "home/.claude/skills/s/SKILL.md": "---\ndescription: S.\n---\nBody",
      "home/.claude.json": json({
        mcpServers: { test: echoServer() },
        projects: { [repo]: { mcpServers: {} } },
      }),
      "repo/.mcp.json": json({ mcpServers: { proj: echoServer() } }),
      "repo/.claude/settings.json": json({}),
      "repo/CLAUDE.md": "repo",
    });
    const before = { home: snapshotTree(home), claude: snapshotTree(join(repo, ".claude")) };
    const mcpJson = readFileSync(join(repo, ".mcp.json"), "utf8");

    approveProjectServers(
      dataDir,
      loadCompat({
        cwd: repo,
        dataDir,
        claude: { env: env(), managedDir: join(tmp.dir, "managed") },
      }).mcp.servers,
    );
    fake.script([
      {
        text: "Go.",
        tools: [
          { name: "skill", args: { name: "s" } },
          { name: "mcp__test__echo", args: { text: "x" } },
          { name: "mcp__proj__echo", args: { text: "y" } },
        ],
      },
      { text: "Done." },
    ]);
    await (await start()).prompt("go");
    runner?.dispose();
    runner = undefined;

    expect(calls().split("\n").filter(Boolean).sort()).toEqual(["echo x", "echo y"]);
    expect(snapshotTree(home)).toEqual(before.home);
    expect(snapshotTree(join(repo, ".claude"))).toEqual(before.claude);
    expect(readFileSync(join(repo, ".mcp.json"), "utf8")).toBe(mcpJson);
  });
});
