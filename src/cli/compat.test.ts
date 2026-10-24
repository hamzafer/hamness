// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax is the fixture.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { snapshotTree, writeTree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { runCli } from "./run.ts";

let tmp: ReturnType<typeof tempHome>;
let out: string[];
let err: string[];
let env: Record<string, string>;
let repo: string;

beforeEach(() => {
  tmp = tempHome();
  repo = join(tmp.dir, "repo");
  env = { HAMNESS_HOME: join(tmp.dir, "data"), HOME: join(tmp.dir, "home") };
  out = [];
  err = [];
  writeTree(tmp.dir, {
    "repo/.git/HEAD": "",
    "home/.claude/CLAUDE.md": "user rules",
    "home/.claude/skills/deploy/SKILL.md":
      "---\ndescription: Deploys the app.\nallowed-tools: Bash(*)\n---\nBody",
    "home/.claude/skills/secret/SKILL.md":
      "---\ndescription: User only.\ndisable-model-invocation: true\n---\nBody",
    "home/.claude.json": JSON.stringify({
      mcpServers: {
        github: { command: "gh-mcp", env: { TOKEN: "${GH_TOKEN}" } },
        old: { type: "sse", url: "https://h.test" },
      },
    }),
    "repo/CLAUDE.md": "repo rules @missing-is-fine.md",
    "repo/.mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }),
  });
});
afterEach(() => tmp.cleanup());

const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const run = (...args: string[]) => runCli(["compat", ...args, "--cwd", repo], env, io);
const text = () => out.join("\n");

describe("hamness compat", () => {
  test("prints the instruction files, skills and MCP servers found, and what happens to them", async () => {
    expect(await run()).toBe(0);
    const t = text();
    expect(t).toContain(join(tmp.dir, "home/.claude"));
    expect(t).toMatch(/user\s+.*home\/\.claude\/CLAUDE\.md/);
    expect(t).toMatch(/project\s+.*repo\/CLAUDE\.md/);
    expect(t).toMatch(/deploy\s+user\s+Deploys the app\./);
    expect(t).toContain("not honored: allowed-tools");
    expect(t).toMatch(/secret\s+user\s+.*user only/);
    expect(t).toMatch(/github\s+user\s+start/);
    expect(t).toContain("GH_TOKEN is not set");
    expect(t).toMatch(/team\s+project\s+needs approval/);
    expect(t).toMatch(/old\s+user\s+unsupported/);
    expect(t).toContain("hamness trust");
  });

  test("--json prints the same as data", async () => {
    expect(await run("--json")).toBe(0);
    const data = JSON.parse(text());
    expect(data.mcp.servers.map((s: { name: string }) => s.name).sort()).toEqual([
      "github",
      "old",
      "team",
    ]);
    expect(data.skills.skills.map((s: { name: string }) => s.name)).toEqual(["deploy", "secret"]);
  });

  test("approve starts the repo's project servers next time; revoke undoes it", async () => {
    const claudeBefore = snapshotTree(join(tmp.dir, "home"));
    expect(await run("approve")).toBe(0);
    expect(text()).toMatch(/Trusted .*repo:\n\s+team/);
    out = [];
    await run();
    expect(text()).toMatch(/team\s+project\s+start/);

    out = [];
    expect(await run("revoke")).toBe(0);
    expect(text()).toContain("Revoked team");
    out = [];
    await run();
    expect(text()).toMatch(/team\s+project\s+needs approval/);
    expect(snapshotTree(join(tmp.dir, "home"))).toEqual(claudeBefore);
  });

  test("approve with nothing pending says so", async () => {
    await run("approve");
    out = [];
    expect(await run("approve")).toBe(0);
    expect(text()).toContain("nothing new");
    out = [];
    expect(await run("approve", "team")).toBe(0);
    expect(text()).toContain("No project MCP servers wait for approval");
  });

  test("unknown subcommand is a usage error", async () => {
    expect(await run("nope")).toBe(2);
    expect(err.join("\n")).toContain("Usage: hamness compat");
  });
});
