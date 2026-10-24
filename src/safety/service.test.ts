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
  check = async (command) => {
    const toolCallId = store.addToolCall(
      { sessionId, agentId, taskId: undefined },
      { messageId: undefined, tool: "bash", argsJson: "{}" },
    );
    const v = await safety.check({ sessionId, toolCallId, tool: "bash", args: { command }, cwd });
    return v.allow;
  };
});
afterEach(() => tmp.cleanup());

describe("the safety service expands shell globs against the disk (S-M1)", () => {
  test("a glob that matches a secret is denied; one over plain files is allowed", async () => {
    expect(await check("cat ~/.ss?/id_rsa")).toBe(false);
    expect(await check("cat .en?")).toBe(false);
    expect(await check("cat *.ts")).toBe(true);
  });
});
