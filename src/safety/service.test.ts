import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { ChatStore } from "../agent/store.ts";
import { openDatabase } from "../db/open.ts";
import { createSafetyService } from "./service.ts";

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
