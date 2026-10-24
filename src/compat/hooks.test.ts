import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "../../test/support/hooks.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { type ClaudeHooks, createClaudeHooks, isProjectTrusted, trustProject } from "./hooks.ts";

let home: ReturnType<typeof tempHome>;
let claudeDir: string;
let dataDir: string;
let work: string;
let fx: ReturnType<typeof hookFixture>;
let hooks: ClaudeHooks;
let logged: string[];

beforeEach(() => {
  home = tempHome();
  const root = realpathSync(home.dir);
  claudeDir = join(root, "claude");
  dataDir = join(root, "data");
  work = join(root, "work");
  mkdirSync(work);
  mkdirSync(dataDir);
  fx = hookFixture(root);
  logged = [];
  hooks = createClaudeHooks({ claudeDir, dataDir, log: (m) => logged.push(m) });
});
afterEach(() => home.cleanup());

const session = () => ({ sessionId: "s1", cwd: work, permissionMode: "default" });
const bash = (command: string) => ({ tool: "bash", args: { command }, toolUseId: "t1" });

describe("PreToolUse", () => {
  test("a matching hook gets Claude Code's input on stdin, runs in the cwd with CLAUDE_PROJECT_DIR", async () => {
    fx.settings(claudeDir, { PreToolUse: [{ matcher: "Bash" }] });
    expect(await hooks.preToolUse(session(), bash("ls"))).toBeUndefined();
    const [call] = fx.calls();
    expect(call?.input).toEqual({
      session_id: "s1",
      transcript_path: "",
      cwd: work,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
    });
    expect(call?.cwd).toBe(work);
    expect(call?.projectDir).toBe(work);
  });

  test("the matcher picks tools by Claude Code name: exact, list or regex", async () => {
    fx.settings(claudeDir, {
      PreToolUse: [{ matcher: "Read" }, { matcher: "Edit|Write" }, { matcher: "^B.sh$" }],
    });
    await hooks.preToolUse(session(), bash("ls"));
    await hooks.preToolUse(session(), { tool: "write", args: { path: "a" }, toolUseId: "t2" });
    await hooks.preToolUse(session(), { tool: "grep", args: { pattern: "x" }, toolUseId: "t3" });
    expect(fx.calls().map((c) => c.input.tool_name)).toEqual(["Bash", "Write"]);
  });

  test("permissionDecision deny comes back with its reason and the hook that said it", async () => {
    fx.settings(claudeDir, { PreToolUse: [{}] });
    fx.respond({
      PreToolUse: {
        stdout: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "no rm here",
          },
        },
      },
    });
    const out = await hooks.preToolUse(session(), bash("rm x"));
    expect(out).toMatchObject({ decision: "deny", reason: "no rm here" });
    expect(out?.hook).toContain("hook.ts");
  });

  test("exit code 2 denies with stderr as the reason", async () => {
    fx.settings(claudeDir, { PreToolUse: [{}] });
    fx.respond({ PreToolUse: { exit: 2, stderr: "blocked by policy" } });
    expect(await hooks.preToolUse(session(), bash("ls"))).toMatchObject({
      decision: "deny",
      reason: "blocked by policy",
    });
  });

  test("several hooks: deny wins over ask over allow", async () => {
    const allow = { hookSpecificOutput: { permissionDecision: "allow" } };
    fx.settings(claudeDir, { PreToolUse: [{}] });
    fx.settings(join(work, ".claude"), {
      PreToolUse: [{ command: `echo '${JSON.stringify(allow)}'` }],
    });
    trustProject(dataDir, work);
    fx.respond({ PreToolUse: { stdout: { hookSpecificOutput: { permissionDecision: "ask" } } } });
    expect((await hooks.preToolUse(session(), bash("ls")))?.decision).toBe("ask");
  });

  test("a hook that crashes or prints junk decides nothing, and it is logged", async () => {
    fx.settings(claudeDir, { PreToolUse: [{ command: "exit 3" }, { command: "echo '{nope'" }] });
    expect(await hooks.preToolUse(session(), bash("ls"))).toBeUndefined();
    expect(logged.join("\n")).toContain("exit code 3");
  });

  test("a hook that hangs is killed at its timeout and decides nothing", async () => {
    fx.settings(claudeDir, { PreToolUse: [{ timeout: 0.3 }] });
    fx.respond({ PreToolUse: { sleepMs: 30_000 } });
    const t0 = Date.now();
    expect(await hooks.preToolUse(session(), bash("ls"))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(logged.join("\n")).toContain("timed out");
  });

  test("a shell hook whose child keeps the pipe open still times out", async () => {
    fx.settings(claudeDir, { PreToolUse: [{ command: "sleep 30; echo done", timeout: 0.3 }] });
    const t0 = Date.now();
    expect(await hooks.preToolUse(session(), bash("ls"))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("exec form (args) runs without a shell, with the project dir placeholder filled in", async () => {
    mkdirSync(claudeDir, { recursive: true });
    const log = join(work, "exec.log");
    const handler = {
      type: "command",
      command: process.execPath,
      args: [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(log)}, process.argv[1])`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder.
        "${CLAUDE_PROJECT_DIR}/x",
      ],
    };
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [handler] }] } }),
    );
    await hooks.preToolUse(session(), bash("ls"));
    expect(readFileSync(log, "utf8")).toBe(`${work}/x`);
  });

  test("disableAllHooks turns them off", async () => {
    fx.settings(claudeDir, { PreToolUse: [{}] }, "settings.json", { disableAllHooks: true });
    await hooks.preToolUse(session(), bash("ls"));
    expect(fx.calls()).toHaveLength(0);
  });

  test("the same command in two files runs once", async () => {
    fx.settings(claudeDir, { PreToolUse: [{}, {}] });
    await hooks.preToolUse(session(), bash("ls"));
    expect(fx.calls()).toHaveLength(1);
  });
});

describe("project hooks and trust", () => {
  test("project hooks don't run until the project is trusted; user hooks always do", async () => {
    fx.settings(join(work, ".claude"), { PreToolUse: [{}] });
    fx.settings(
      join(work, ".claude"),
      { PreToolUse: [{ matcher: "Read" }] },
      "settings.local.json",
    );
    await hooks.preToolUse(session(), bash("ls"));
    expect(fx.calls()).toHaveLength(0);
    expect(isProjectTrusted(dataDir, work)).toBe(false);

    trustProject(dataDir, work);
    expect(isProjectTrusted(dataDir, work)).toBe(true);
    await hooks.preToolUse(session(), bash("ls"));
    await hooks.preToolUse(session(), { tool: "read", args: { path: "a" }, toolUseId: "t2" });
    expect(fx.calls().map((c) => c.input.tool_name)).toEqual(["Bash", "Read"]);
  });

  test("trust is per repo and kept in hamness's config, next to other settings", async () => {
    mkdirSync(join(work, ".git"));
    mkdirSync(join(work, "sub"));
    trustProject(dataDir, join(work, "sub"));
    expect(isProjectTrusted(dataDir, work)).toBe(true);
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(config.hooks.trustedProjects).toEqual([work]);
  });

  test("sessionStart says when project hooks are held back", async () => {
    fx.settings(join(work, ".claude"), { Stop: [{}] });
    const out = await hooks.sessionStart(session(), { source: "startup" });
    expect(out.notice).toContain("hamness hooks trust");
  });
});

describe("the other events", () => {
  test("PostToolUse gets the input and response; its block reason and context go to the model", async () => {
    fx.settings(claudeDir, { PostToolUse: [{ matcher: "Write" }] });
    fx.respond({
      PostToolUse: {
        stdout: {
          decision: "block",
          reason: "lint failed",
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "see eslint" },
        },
      },
    });
    const out = await hooks.postToolUse(session(), {
      tool: "write",
      args: { path: "a.ts", content: "x" },
      toolUseId: "t9",
      output: "wrote 1 byte",
    });
    expect(out.context).toBe("lint failed\n\nsee eslint");
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(work, "a.ts"), content: "x" },
      tool_response: { filePath: join(work, "a.ts"), output: "wrote 1 byte" },
      tool_use_id: "t9",
    });
  });

  test("UserPromptSubmit gets the prompt; plain stdout is context, decision block blocks", async () => {
    fx.settings(claudeDir, { UserPromptSubmit: [{ matcher: "ignored" }] });
    fx.respond({ UserPromptSubmit: { stdout: "today is Friday" } });
    expect(await hooks.userPromptSubmit(session(), "hello")).toEqual({
      context: "today is Friday",
    });
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });

    fx.respond({ UserPromptSubmit: { stdout: { decision: "block", reason: "no secrets" } } });
    expect(await hooks.userPromptSubmit(session(), "my password")).toEqual({
      blocked: "no secrets",
    });
    fx.respond({ UserPromptSubmit: { exit: 2, stderr: "nope" } });
    expect(await hooks.userPromptSubmit(session(), "x")).toEqual({ blocked: "nope" });
  });

  test("Stop gets stop_hook_active and the last reply; a block continues with the reason", async () => {
    fx.settings(claudeDir, { Stop: [{}] });
    fx.respond({ Stop: { stdout: { decision: "block", reason: "run the tests first" } } });
    expect(
      await hooks.stop(session(), { stopHookActive: false, lastAssistantMessage: "done!" }),
    ).toEqual({ continueWith: "run the tests first" });
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "done!",
      background_tasks: [],
      session_crons: [],
    });
    fx.respond({ Stop: { stdout: { continue: false, decision: "block", reason: "x" } } });
    expect(await hooks.stop(session(), { stopHookActive: true, lastAssistantMessage: "" })).toEqual(
      {},
    );
  });

  test("SessionStart matches the source and adds its output as context", async () => {
    fx.settings(claudeDir, { SessionStart: [{ matcher: "startup" }] });
    fx.respond({
      SessionStart: { stdout: { hookSpecificOutput: { additionalContext: "branch: main" } } },
    });
    expect(await hooks.sessionStart(session(), { source: "resume" })).toEqual({});
    expect(await hooks.sessionStart(session(), { source: "startup", model: "m/x" })).toEqual({
      context: "branch: main",
    });
    expect(fx.calls()[0]?.input).toMatchObject({
      hook_event_name: "SessionStart",
      source: "startup",
      model: "m/x",
    });
  });
});
