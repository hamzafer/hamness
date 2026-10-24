import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway hamness data dir. Call `cleanup` in afterEach. */
export function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hamness-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
