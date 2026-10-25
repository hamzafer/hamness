import { describe, expect, test } from "bun:test";
import { bashWrites } from "./bash-writes.ts";

const cwd = "/work";

describe("bashWrites: files a bash command writes", () => {
  test("a heredoc into a file, either order, quoted or not", () => {
    for (const cmd of [
      "cat > calc.ts <<'EOF'\nexport const add = (a: number, b: number) => a + b;\nEOF",
      'cat <<"EOF" > calc.ts\nconst x = 1 > 0;\nEOF',
      "cat <<-EOF >calc.ts\n\tif (a >> 1) {}\n\tEOF",
    ]) {
      expect(bashWrites(cmd, cwd)).toEqual({ writes: true, paths: ["/work/calc.ts"] });
    }
  });

  test("redirections and tee, with cd followed", () => {
    expect(bashWrites("echo hi > a.txt", cwd).paths).toEqual(["/work/a.txt"]);
    expect(bashWrites("echo hi >> logs/b.txt", cwd).paths).toEqual(["/work/logs/b.txt"]);
    expect(bashWrites("cd web && printf x > package.json", cwd).paths).toEqual([
      "/work/web/package.json",
    ]);
    expect(bashWrites("echo x | tee -a one.txt two.txt", cwd).paths).toEqual([
      "/work/one.txt",
      "/work/two.txt",
    ]);
  });

  test("a target known only at run time still counts as a write", () => {
    expect(bashWrites('echo x > "$OUT"', cwd)).toEqual({ writes: true, paths: [] });
  });

  test("reads, descriptor copies and /dev targets write nothing", () => {
    for (const cmd of [
      "bun test",
      "ls -la",
      "bun test 2>&1",
      "bun test > /dev/null 2>&1",
      "grep -r foo src < input.txt",
      "cat <<< 'a > b'",
      "echo '>' x",
      "cat <<'EOF'\na > b\nEOF",
    ]) {
      expect(bashWrites(cmd, cwd)).toEqual({ writes: false, paths: [] });
    }
  });

  test("a command it cannot parse writes if it has a > outside quotes", () => {
    expect(bashWrites("cat > x.ts <<EOF\nunclosed", cwd).writes).toBe(true);
    expect(bashWrites("echo 'unclosed > x", cwd).writes).toBe(false);
    expect(bashWrites("echo ( > x", cwd).writes).toBe(true);
  });
});
