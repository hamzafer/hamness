import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkContext } from "../../../test/support/check-context.ts";
import { tempHome } from "../../../test/support/temp-home.ts";
import { checkFile } from "./file.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

const ctx = (startedAt = Date.now() - 1000) => checkContext(home.dir, { taskStartedAt: startedAt });

describe("file checker", () => {
  test("passes for a non-empty file written during the task, and stores its sha256", async () => {
    mkdirSync(join(home.dir, "out"));
    writeFileSync(join(home.dir, "out", "shot.png"), "hello");
    const r = await checkFile({ kind: "file", path: "out/shot.png" }, ctx());
    expect(r.status).toBe("passed");
    expect(r.details.size).toBe(5);
    // sha256("hello"), a known value.
    expect(r.details.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(typeof r.details.mtimeMs).toBe("number");
  });

  test("accepts an absolute path", async () => {
    writeFileSync(join(home.dir, "a.txt"), "x");
    const r = await checkFile({ kind: "file", path: join(home.dir, "a.txt") }, ctx());
    expect(r.status).toBe("passed");
  });

  test("fails for a missing file", async () => {
    const r = await checkFile({ kind: "file", path: "nope.png" }, ctx());
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("does not exist");
  });

  test("fails for an empty file", async () => {
    writeFileSync(join(home.dir, "empty.log"), "");
    const r = await checkFile({ kind: "file", path: "empty.log" }, ctx());
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("empty");
  });

  test("fails for a directory", async () => {
    mkdirSync(join(home.dir, "dir"));
    const r = await checkFile({ kind: "file", path: "dir" }, ctx());
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("not a file");
  });

  test("fails for a file last written before the task started", async () => {
    const file = join(home.dir, "old.txt");
    writeFileSync(file, "stale");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(file, hourAgo, hourAgo);
    const r = await checkFile({ kind: "file", path: "old.txt" }, ctx(Date.now() - 60_000));
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("before the task");
  });

  test("refuses a file outside the session folder: absolute, ../ or through a symlink (C-2)", async () => {
    const work = join(home.dir, "work");
    mkdirSync(work);
    writeFileSync(join(home.dir, "outside.txt"), "secret-ish");
    const inWork = (path: string) =>
      checkFile({ kind: "file", path }, checkContext(work, { taskStartedAt: Date.now() - 1000 }));
    for (const path of [join(home.dir, "outside.txt"), "../outside.txt"]) {
      const r = await inWork(path);
      expect(r.status).toBe("error");
      expect(r.summary).toContain("outside the session folder");
      expect(r.details.sha256).toBeUndefined();
    }
    symlinkSync(join(home.dir, "outside.txt"), join(work, "link.txt"));
    const linked = await inWork("link.txt");
    expect(linked.status).toBe("error");
    expect(linked.summary).toContain("outside the session folder");
  });
});
