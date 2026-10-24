import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "../../test/support/hooks.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { isProjectTrusted } from "../compat/hooks.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

let home: ReturnType<typeof tempHome>;
let root: string;
let work: string;
beforeEach(() => {
  home = tempHome();
  root = realpathSync(home.dir);
  work = join(root, "work");
  mkdirSync(work);
});
afterEach(() => home.cleanup());

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { cli, text: () => [...out, ...err].join("\n") };
}
const env = () => ({ HAMNESS_HOME: join(root, "data"), CLAUDE_CONFIG_DIR: join(root, "claude") });

describe("hamness hooks", () => {
  test("lists the hooks it found and says which project ones wait for trust", async () => {
    const fx = hookFixture(root);
    fx.settings(join(root, "claude"), { Stop: [{ command: "echo user-hook" }] });
    fx.settings(join(work, ".claude"), {
      PreToolUse: [{ matcher: "Bash", command: "echo proj-hook" }],
    });
    const t = io();
    expect(await runCli(["hooks", work], env(), t.cli)).toBe(0);
    expect(t.text()).toContain("Stop");
    expect(t.text()).toContain("echo user-hook");
    expect(t.text()).toContain("PreToolUse Bash");
    expect(t.text()).toContain("echo proj-hook");
    expect(t.text()).toContain("not trusted");
  });

  test("trust lets the project's hooks run", async () => {
    const t = io();
    expect(await runCli(["hooks", "trust", work], env(), t.cli)).toBe(0);
    expect(isProjectTrusted(join(root, "data"), work)).toBe(true);
    expect(t.text()).toContain(work);
  });
});
