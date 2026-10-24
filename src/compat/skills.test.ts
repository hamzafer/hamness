// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax is the fixture.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { writeTree } from "../../test/support/files.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { discoverSkills, renderSkill, skillsPrompt } from "./skills.ts";

let tmp: ReturnType<typeof tempHome>;
let home: string;
let repo: string;
let cwd: string;
let dataDir: string;

beforeEach(() => {
  tmp = tempHome();
  home = join(tmp.dir, "home");
  repo = join(tmp.dir, "repo");
  cwd = join(repo, "pkg");
  dataDir = join(tmp.dir, "data");
  writeTree(tmp.dir, { "repo/.git/HEAD": "", "repo/pkg/x": "" });
});
afterEach(() => tmp.cleanup());

const discover = (env: Record<string, string> = {}) =>
  discoverSkills({ cwd, dataDir, claude: { env: { HOME: home, ...env } } });

const skill = (fm: string, body = "Body.") => `---\n${fm}\n---\n${body}\n`;

describe("skill discovery", () => {
  test("finds personal, hamness, and project skills up to the repo root; personal wins a clash", () => {
    writeTree(tmp.dir, {
      "home/.claude/skills/deploy/SKILL.md": skill("description: personal deploy"),
      "data/skills/notes/SKILL.md": skill("description: hamness notes"),
      "repo/.claude/skills/deploy/SKILL.md": skill("description: project deploy"),
      "repo/.claude/skills/lint/SKILL.md": skill("description: repo lint"),
      "repo/pkg/.claude/skills/lint/SKILL.md": skill("description: nearer lint"),
      "repo/.hamness/skills/check/SKILL.md": skill("description: hamness project check"),
      "repo/.claude/skills/not-a-skill/README.md": "no SKILL.md",
    });
    const { skills } = discover();
    expect(skills.map((s) => [s.name, s.description, s.scope])).toEqual([
      ["deploy", "personal deploy", "user"],
      ["notes", "hamness notes", "user"],
      ["lint", "nearer lint", "project"],
      ["check", "hamness project check", "project"],
    ]);
  });

  test("CLAUDE_CONFIG_DIR moves the personal folder", () => {
    writeTree(tmp.dir, {
      "home/.claude/skills/a/SKILL.md": skill("description: default"),
      "alt/skills/b/SKILL.md": skill("description: alt"),
    });
    expect(discover({ CLAUDE_CONFIG_DIR: join(tmp.dir, "alt") }).skills.map((s) => s.name)).toEqual(
      ["b"],
    );
  });

  test("reads Claude Code's frontmatter: name, when_to_use, flags, defaults", () => {
    writeTree(tmp.dir, {
      "repo/.claude/skills/one/SKILL.md": skill(
        "name: renamed\ndescription: Does one.\nwhen_to_use: When asked for one.\ndisable-model-invocation: yes\nuser-invocable: off\nallowed-tools: Bash(git *)\nmodel: opus",
      ),
      "repo/.claude/skills/two/SKILL.md": "\n\nFirst line is the description.\nMore.\n",
      "repo/.claude/skills/bad/SKILL.md": "---\nname: [unclosed\n---\nBad YAML body.\n",
    });
    const byName = Object.fromEntries(discover().skills.map((s) => [s.name, s]));
    expect(byName.renamed).toMatchObject({
      description: "Does one.",
      whenToUse: "When asked for one.",
      disableModelInvocation: true,
      userInvocable: false,
      ignoredFields: ["allowed-tools", "model"],
    });
    expect(byName.two?.description).toBe("First line is the description.");
    expect(byName.bad?.description).toBe("Bad YAML body.");
  });

  test("a symlinked skill folder loads once", () => {
    writeTree(tmp.dir, { "shared/x/SKILL.md": skill("description: shared") });
    writeTree(tmp.dir, { "home/.claude/skills/.keep": "" });
    symlinkSync(join(tmp.dir, "shared/x"), join(home, ".claude/skills/x"));
    symlinkSync(join(tmp.dir, "shared/x"), join(home, ".claude/skills/y"));
    expect(discover().skills.map((s) => s.description)).toEqual(["shared"]);
  });
});

describe("skill listing and bodies", () => {
  test("the prompt lists model-invocable skills with description and when_to_use", () => {
    writeTree(tmp.dir, {
      "repo/.claude/skills/a/SKILL.md": skill("description: Alpha <tool>.\nwhen_to_use: For A."),
      "repo/.claude/skills/b/SKILL.md": skill(
        "description: Hidden.\ndisable-model-invocation: true",
      ),
    });
    const text = skillsPrompt(discover().skills);
    expect(text).toContain("<name>a</name>");
    expect(text).toContain("<description>Alpha &lt;tool&gt;. For A.</description>");
    expect(text).not.toContain("Hidden");
    expect(text).toContain("`skill` tool");
    expect(skillsPrompt([])).toBe("");
  });

  test("bodies substitute arguments and Claude Code's variables", () => {
    writeTree(tmp.dir, {
      "repo/.claude/skills/fix/SKILL.md": skill(
        "description: Fix an issue.\narguments: [issue, branch]",
        "Fix $ARGUMENTS. First $0, second $ARGUMENTS[1], named $issue on $branch.\nDir ${CLAUDE_SKILL_DIR}, project ${CLAUDE_PROJECT_DIR}, session ${CLAUDE_SESSION_ID}.",
      ),
      "repo/.claude/skills/plain/SKILL.md": skill("description: Plain.", "No placeholders."),
    });
    const { skills } = discover();
    const fix = skills.find((s) => s.name === "fix");
    if (!fix) throw new Error("no fix skill");
    expect(renderSkill(fix, { args: '42 "feature x"', projectDir: repo, sessionId: "s1" })).toBe(
      `Base directory for this skill: ${join(repo, ".claude/skills/fix")}\n\nFix 42 "feature x". First 42, second feature x, named 42 on feature x.\nDir ${join(repo, ".claude/skills/fix")}, project ${repo}, session s1.`,
    );
    const plain = skills.find((s) => s.name === "plain");
    if (!plain) throw new Error("no plain skill");
    expect(renderSkill(plain, { args: "extra", projectDir: repo })).toEndWith(
      "No placeholders.\n\nARGUMENTS: extra",
    );
  });
});
