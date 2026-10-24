import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { readJson, writeJsonAtomic } from "./json.ts";

describe("writeJsonAtomic", () => {
  test("an owner-only file gets owner-only new folders (a fresh data dir is 0700)", () => {
    const h = tempHome();
    try {
      const path = join(h.dir, "data", "config.json");
      writeJsonAtomic(path, { a: 1 }, 0o600);
      expect(readJson(path)).toEqual({ a: 1 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(h.dir, "data")).mode & 0o777).toBe(0o700);
    } finally {
      h.cleanup();
    }
  });
});
