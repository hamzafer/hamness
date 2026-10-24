// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax is the fixture.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeTree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { approveProjectServers, revokeProjectServers } from "./approvals.ts";
import { loadMcpServers } from "./mcp.ts";

let tmp: ReturnType<typeof tempHome>;
let home: string;
let repo: string;
let dataDir: string;

beforeEach(() => {
  tmp = tempHome();
  home = join(tmp.dir, "home");
  repo = join(tmp.dir, "repo");
  dataDir = join(tmp.dir, "data");
  writeTree(tmp.dir, { "repo/.git/HEAD": "" });
});
afterEach(() => tmp.cleanup());

const json = (v: unknown) => JSON.stringify(v, null, 2);
const load = (env: Record<string, string> = {}, cwd = repo) =>
  loadMcpServers({ cwd, dataDir, claude: { env: { HOME: home, ...env } } });
const byName = (r: ReturnType<typeof load>) =>
  Object.fromEntries(r.servers.map((s) => [s.name, s]));

describe("MCP servers from Claude Code's config", () => {
  test("user, local and project scopes; local beats project beats user, whole entry", () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({
        numStartups: 3,
        mcpServers: {
          shared: { command: "user-shared" },
          mine: { type: "http", url: "https://example.test/mcp" },
        },
        projects: {
          [repo]: { mcpServers: { shared: { command: "local-shared", args: ["-x"] } } },
          "/elsewhere": { mcpServers: { other: { command: "nope" } } },
        },
      }),
      "repo/.mcp.json": json({
        mcpServers: { shared: { command: "project-shared" }, team: { command: "team-tool" } },
      }),
    });
    const s = byName(load());
    expect(Object.keys(s).sort()).toEqual(["mine", "shared", "team"]);
    expect(s.shared).toMatchObject({ scope: "local", status: "start" });
    expect(s.shared?.config).toEqual({ command: "local-shared", args: ["-x"], exposure: "direct" });
    expect(s.mine).toMatchObject({ scope: "user", status: "start" });
    expect(s.mine?.config).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      exposure: "direct",
    });
    expect(s.team).toMatchObject({ scope: "project", status: "needs-approval" });
  });

  test("CLAUDE_CONFIG_DIR moves .claude.json into that folder", () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({ mcpServers: { a: { command: "a" } } }),
      "alt/.claude.json": json({ mcpServers: { b: { command: "b" } } }),
    });
    expect(load({ CLAUDE_CONFIG_DIR: join(tmp.dir, "alt") }).servers.map((s) => s.name)).toEqual([
      "b",
    ]);
  });

  test("expands ${VAR} and ${VAR:-default}; a missing one stays literal with a warning", () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({
        mcpServers: {
          s: {
            command: "${TOOL_BIN}/srv",
            args: ["--root", "${ROOT:-/srv}", "${NOPE}"],
            env: { TOKEN: "${TOKEN}", LITERAL: "$HOME and !bang" },
          },
          r: {
            type: "http",
            url: "${BASE}/mcp",
            headers: { Authorization: "Bearer ${TOKEN}", "X-Key": "${ANTHROPIC_API_KEY:-x}" },
          },
        },
      }),
    });
    const s = byName(
      load({ TOOL_BIN: "/opt/bin", TOKEN: "t0k", BASE: "https://h.test", ANTHROPIC_API_KEY: "k" }),
    );
    expect(s.s?.config).toMatchObject({
      command: "/opt/bin/srv",
      args: ["--root", "/srv", "${NOPE}"],
      // Escaped for Pi, which would otherwise expand `$HOME` or run `!cmd` values itself.
      env: { TOKEN: "t0k", LITERAL: "$$HOME and !bang" },
    });
    expect(s.s?.warnings).toEqual(["NOPE is not set"]);
    // Credential-like variables read as empty in a remote server's url and headers.
    expect(s.r?.config).toMatchObject({
      url: "https://h.test/mcp",
      headers: { Authorization: "Bearer t0k", "X-Key": "" },
    });
  });

  test("a value starting with ! is passed to Pi as a literal, not a command", () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({ mcpServers: { s: { command: "x", env: { A: "!echo hi" } } } }),
    });
    expect(byName(load()).s?.config).toMatchObject({ env: { A: "$!echo hi" } });
  });

  test("unsupported transports and bad entries are reported, not started", () => {
    writeTree(tmp.dir, {
      "home/.claude.json": json({
        mcpServers: {
          old: { type: "sse", url: "https://h.test/sse" },
          sock: { type: "ws", url: "wss://h.test" },
          bare: { url: "https://h.test/mcp" },
          empty: {},
          "bad name": { command: "x" },
          helper: { type: "http", url: "https://h.test", headersHelper: "get-token" },
        },
      }),
    });
    const s = byName(load());
    expect(s.old?.status).toBe("unsupported");
    expect(s.sock?.status).toBe("unsupported");
    expect(s.bare?.status).toBe("unsupported");
    expect(s.empty?.status).toBe("unsupported");
    expect(s["bad name"]?.status).toBe("unsupported");
    expect(s.helper?.status).toBe("start");
    expect(s.helper?.warnings).toEqual(["headersHelper is not supported; no headers from it"]);
  });

  test("disabledMcpjsonServers in Claude Code settings keeps a project server off", () => {
    writeTree(tmp.dir, {
      "repo/.mcp.json": json({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }),
      "repo/.claude/settings.json": json({ disabledMcpjsonServers: ["a"] }),
      "home/.claude.json": json({ projects: { [repo]: { disabledMcpServers: ["b"] } } }),
    });
    const s = byName(load());
    expect(s.a?.status).toBe("disabled");
    expect(s.b?.status).toBe("disabled");
  });
});

describe("project server approval", () => {
  test("approval is once per repo, stored in hamness's config; a changed entry asks again", () => {
    writeTree(tmp.dir, {
      "repo/.mcp.json": json({ mcpServers: { team: { command: "team-tool" } } }),
      "repo/pkg/x": "",
    });
    expect(byName(load()).team?.status).toBe("needs-approval");

    const approved = approveProjectServers(dataDir, load().servers);
    expect(approved).toEqual(["team"]);
    expect(byName(load()).team?.status).toBe("start");
    // The same repo from a subfolder.
    expect(byName(load({}, join(repo, "pkg"))).team?.status).toBe("start");

    writeTree(tmp.dir, {
      "repo/.mcp.json": json({ mcpServers: { team: { command: "team-tool", args: ["--evil"] } } }),
    });
    expect(byName(load()).team?.status).toBe("needs-approval");

    approveProjectServers(dataDir, load().servers);
    revokeProjectServers(dataDir, repo);
    expect(byName(load()).team?.status).toBe("needs-approval");
  });

  test("approval covers the server's script in the repo: editing it asks again (V-L6)", () => {
    writeTree(tmp.dir, {
      "repo/.mcp.json": json({
        mcpServers: { team: { command: "node", args: ["tools/server.js"] } },
      }),
      "repo/tools/server.js": "console.log(1)",
    });
    approveProjectServers(dataDir, load().servers);
    expect(byName(load()).team?.status).toBe("start");
    writeTree(tmp.dir, { "repo/tools/server.js": "console.log(2)" });
    expect(byName(load()).team?.status).toBe("needs-approval");
  });

  test("a repo can't approve its own servers through .hamness/config.json", () => {
    writeTree(tmp.dir, {
      "repo/.mcp.json": json({ mcpServers: { team: { command: "team-tool" } } }),
    });
    const fingerprint = load().servers[0]?.fingerprint;
    writeTree(tmp.dir, {
      "repo/.hamness/config.json": json({
        trust: { projects: { [repo]: { mcp: { team: fingerprint } } } },
      }),
    });
    expect(byName(load()).team?.status).toBe("needs-approval");
  });
});
