import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* `bun install -g` puts hamness under node_modules, where OpenTUI's stock Solid plugin
 * compiles nothing. A .tsx file there must still load (in a process without bunfig's preload). */

const REPO = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("Solid JSX under node_modules compiles once registered", async () => {
  // Inside the repo's node_modules, so `@opentui/solid` resolves from it.
  const pkg = mkdtempSync(join(REPO, "node_modules", ".hamness-loader-test-"));
  dirs.push(pkg);
  mkdirSync(join(pkg, "src"));
  writeFileSync(
    join(pkg, "src", "view.tsx"),
    "export const View = () => <text>hello</text>;\nexport const kind = typeof View;\n",
  );
  const script = join(pkg, "run.ts");
  writeFileSync(
    script,
    [
      `import { registerSolidTransform } from ${JSON.stringify(join(REPO, "src", "tui", "loader.ts"))};`,
      `await registerSolidTransform(${JSON.stringify(join(pkg, "src"))});`,
      `const m = await import(${JSON.stringify(join(pkg, "src", "view.tsx"))});`,
      "console.log(m.kind);",
    ].join("\n"),
  );
  const cwd = mkdtempSync(join(tmpdir(), "hamness-cwd-"));
  dirs.push(cwd);
  const proc = Bun.spawn(["bun", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(err).not.toContain("react");
  expect(out.trim()).toBe("function");
  expect(await proc.exited).toBe(0);
});
