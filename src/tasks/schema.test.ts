import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { type HamnessDb, openDatabase } from "../db/open.ts";

/*
 * The proof gate is also enforced by the database (migration 0006), so no code path, and no
 * agent running `sqlite3` on the file, can mark evidence passed or a task verified on its own.
 */

let home: ReturnType<typeof tempHome>;
let db: HamnessDb;
beforeEach(() => {
  home = tempHome();
  db = openDatabase(join(home.dir, "h.sqlite"));
  db.sqlite.run(
    "INSERT INTO sessions (id, source, cwd, created_at, updated_at) VALUES ('s1', 'hamness', '/w', 1, 1)",
  );
  db.sqlite.run(
    "INSERT INTO tasks (id, session_id, goal, created_at, updated_at) VALUES ('t1', 's1', 'g', 1, 1)",
  );
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const claim = (id: string, extra = "") =>
  db.sqlite.run(
    `INSERT INTO evidence (id, task_id, kind, claim_json, created_at, updated_at${extra ? ", status" : ""})
     VALUES ('${id}', 't1', 'command', '{}', 1, 1${extra ? `, '${extra}'` : ""})`,
  );
const check = (id: string, status: string, result: string | null = '{"exitCode":0}') =>
  db.sqlite
    .query("UPDATE evidence SET status = ?, result_json = ?, checked_at = 2 WHERE id = ?")
    .run(status, result, id);
const close = (outcome: string) =>
  db.sqlite.query("UPDATE tasks SET outcome = ? WHERE id = 't1'").run(outcome);

describe("evidence rows", () => {
  test("start as a pending claim: inserting a result is refused", () => {
    expect(() => claim("e1", "passed")).toThrow(/pending claim/);
    claim("e2");
  });

  test("get a result only with its result_json and checked_at", () => {
    claim("e1");
    expect(() => check("e1", "passed", null)).toThrow(/result/);
    check("e1", "passed");
  });

  test("are final once checked", () => {
    claim("e1");
    check("e1", "failed");
    expect(() => check("e1", "passed")).toThrow(/final/);
  });

  test("keep their claim as submitted", () => {
    claim("e1");
    expect(() =>
      db.sqlite.run(`UPDATE evidence SET claim_json = '{"command":"true"}' WHERE id = 'e1'`),
    ).toThrow(/claim/);
  });
});

describe("task outcomes", () => {
  test("verified needs a passed piece of evidence", () => {
    expect(() => close("verified")).toThrow(/proof gate/);
    claim("e1");
    check("e1", "failed");
    expect(() => close("verified")).toThrow(/proof gate/);
    claim("e2");
    check("e2", "passed");
    close("verified");
  });

  test("a closed outcome is final, except unverified can be overridden", () => {
    close("unverified");
    expect(() => close("abandoned")).toThrow(/final/);
    close("overridden");
    expect(() => close("open")).toThrow(/final/);
  });

  test("an override and an abandon can carry the user's reason", () => {
    db.sqlite.run("UPDATE tasks SET outcome = 'abandoned', outcome_reason = 'wrong approach'");
    expect(db.sqlite.query("SELECT outcome_reason FROM tasks").get()).toEqual({
      outcome_reason: "wrong approach",
    });
  });
});
