import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWrites } from "./bash-writes.ts";

const cwd = "/work";
const home = "/home/dev";
const w = (command: string, dir = cwd) => bashWrites(command, dir, home);
const NONE = { writes: false, paths: [] };

describe("bashWrites: files a bash command writes", () => {
  test("a heredoc into a file, either order, any delimiter quoting", () => {
    for (const cmd of [
      "cat > calc.ts <<'EOF'\nexport const add = (a: number, b: number) => a + b;\nEOF",
      'cat <<"EOF" > calc.ts\nconst x = 1 > 0;\nEOF',
      "cat <<-EOF >calc.ts\n\tif (a >> 1) {}\n\tEOF",
      "cat <<\\EOF > calc.ts\nlet y = a > b;\nEOF",
    ]) {
      expect(w(cmd)).toEqual({ writes: true, paths: ["/work/calc.ts"] });
    }
  });

  test("a quoted << is not a heredoc", () => {
    expect(w('echo "<<EOF" > a.txt\necho done')).toEqual({ writes: true, paths: ["/work/a.txt"] });
    expect(w("echo '<<EOF'\necho a > b")).toEqual({ writes: true, paths: ["/work/b"] });
  });

  test("redirections and tee, with cd followed", () => {
    expect(w("echo hi > a.txt").paths).toEqual(["/work/a.txt"]);
    expect(w("echo hi >> logs/b.txt").paths).toEqual(["/work/logs/b.txt"]);
    expect(w("cd web && printf x > package.json").paths).toEqual(["/work/web/package.json"]);
    expect(w("echo x | tee -a one.txt two.txt").paths).toEqual(["/work/one.txt", "/work/two.txt"]);
  });

  test("only files inside the session folder count; temp files and other folders don't", () => {
    for (const cmd of [
      "bun test > /tmp/out.txt",
      `bun test 2>&1 | tee ${join(tmpdir(), "log.txt")}`,
      "echo x > /etc/hosts.bak",
      "echo x > ../sibling.txt",
      "echo x > ~/notes.txt",
      "cd ~ && echo x > notes.txt",
      "cd $HOME && echo x > notes.txt",
    ]) {
      expect(w(cmd)).toEqual(NONE);
    }
    expect(w("echo x > ~/proj/a.txt", "/home/dev/proj").paths).toEqual(["/home/dev/proj/a.txt"]);
    expect(w("cd ~/proj/src && echo x > a.ts", "/home/dev/proj").paths).toEqual([
      "/home/dev/proj/src/a.ts",
    ]);
  });

  test("a target known only at run time still counts as a write, with no path", () => {
    expect(w('echo x > "$OUT"')).toEqual({ writes: true, paths: [] });
    expect(w('cd "$DIR" && echo x > a.txt')).toEqual({ writes: true, paths: [] });
  });

  test("a cd inside a subshell does not leak out of it", () => {
    expect(w("(cd /elsewhere && ls) && echo x > a.txt")).toEqual({ writes: true, paths: [] });
  });

  test("reads, comparisons, arithmetic, descriptor copies and /dev targets write nothing", () => {
    for (const cmd of [
      "bun test",
      "ls -la",
      "bun test 2>&1",
      "bun test > /dev/null 2>&1",
      "grep -r foo src < input.txt",
      "cat <<< 'a > b'",
      "echo '>' x",
      "cat <<'EOF'\na > b\nEOF",
      "[[ a > b ]] && echo yes",
      "(( a > b )) && echo yes",
      "echo $(( 3 > 2 ))",
    ]) {
      expect(w(cmd)).toEqual(NONE);
    }
  });

  test("a command it cannot parse writes if it has a > outside quotes and /dev", () => {
    expect(w("echo ( > x").writes).toBe(true);
    expect(w("echo 'unclosed > x").writes).toBe(false);
    expect(w("f() { bun test; }; f >/dev/null 2>&1").writes).toBe(false);
    expect(w('echo "don\'t > x" (').writes).toBe(false);
  });
});
