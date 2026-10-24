import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { currentVersion, migrate } from "./migrate.ts";
import type { Migration } from "./migrations/types.ts";

const m = (version: number, table: string): Migration => ({
  version,
  name: `m${version}`,
  sql: `CREATE TABLE ${table} (id TEXT);`,
});

const applied = (db: Database) =>
  db
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((r) => r.version);

describe("migrate", () => {
  test("applies migrations whose numbers have gaps (tickets land in any order)", () => {
    const db = new Database(":memory:");
    expect(migrate(db, [m(1, "a"), m(2, "b"), m(6, "f")])).toBe(6);
    expect(applied(db)).toEqual([1, 2, 6]);
  });

  test("a migration that lands after a higher one still runs", () => {
    const db = new Database(":memory:");
    migrate(db, [m(1, "a"), m(6, "f")]);
    migrate(db, [m(1, "a"), m(3, "c"), m(6, "f")]);
    expect(applied(db)).toEqual([1, 3, 6]);
    expect(currentVersion(db)).toBe(6);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toEqual({
      name: "c",
    });
  });

  test("refuses migrations that are not in ascending order", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [m(2, "b"), m(1, "a")])).toThrow(/ascending/);
    expect(() => migrate(db, [m(1, "a"), m(1, "b")])).toThrow(/ascending/);
  });

  test("refuses a database with a migration this hamness does not know", () => {
    const db = new Database(":memory:");
    migrate(db, [m(1, "a"), m(4, "d")]);
    expect(() => migrate(db, [m(1, "a"), m(3, "c")])).toThrow(/newer/);
  });
});
