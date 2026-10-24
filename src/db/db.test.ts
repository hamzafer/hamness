import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../../test/support/temp-home.ts";
import { LATEST_SCHEMA_VERSION } from "./migrations/index.ts";
import { openDatabase } from "./open.ts";

let home: ReturnType<typeof tempHome>;
let file: string;
beforeEach(() => {
  home = tempHome();
  file = join(home.dir, "hamness.sqlite");
});
afterEach(() => home.cleanup());

const specTables = [
  "sessions",
  "agents",
  "messages",
  "tool_calls",
  "model_calls",
  "decisions",
  "tasks",
  "evidence",
];

describe("openDatabase", () => {
  test("the database and its WAL files are owner-only, even when they existed 0644", () => {
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    const db = openDatabase(file);
    db.sqlite.run("CREATE TABLE IF NOT EXISTS t (x)");
    db.sqlite.run("INSERT INTO t VALUES (1)");
    for (const p of [file, `${file}-wal`, `${file}-shm`])
      expect(existsSync(p) ? statSync(p).mode & 0o777 : 0o600).toBe(0o600);
    expect(existsSync(`${file}-wal`)).toBe(true);
    db.close();
  });

  test("a new database file is created owner-only", () => {
    const db = openDatabase(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    db.close();
  });

  test("migrates a fresh file to the latest schema version", () => {
    const db = openDatabase(file);
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  test("creates every table the spec names, each with id and updated_at", () => {
    const db = openDatabase(file);
    for (const table of specTables) {
      const cols = db.sqlite
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((c) => c.name);
      expect(cols).toContain("id");
      expect(cols).toContain("created_at");
      expect(cols).toContain("updated_at");
    }
    db.close();
  });

  test("reopening is idempotent and keeps data", () => {
    const first = openDatabase(file);
    first.sqlite.run(
      "INSERT INTO sessions (id, source, cwd, created_at, updated_at) VALUES ('s1', 'hamness', '/w', 1, 1)",
    );
    first.close();

    const second = openDatabase(file);
    expect(second.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const row = second.sqlite.query("SELECT id FROM sessions").get();
    expect(row).toEqual({ id: "s1" });
    second.close();
  });

  test("updating a row bumps updated_at for later sync", () => {
    const db = openDatabase(file);
    db.sqlite.run(
      "INSERT INTO sessions (id, source, cwd, created_at, updated_at) VALUES ('s1', 'hamness', '/w', 1, 1)",
    );
    db.sqlite.run("UPDATE sessions SET title = 'renamed' WHERE id = 's1'");
    const row = db.sqlite
      .query<{ updated_at: number }, []>("SELECT updated_at FROM sessions")
      .get();
    expect(row?.updated_at).toBeGreaterThan(1);
    db.close();
  });

  test("rejects an outcome outside the spec's five states", () => {
    const db = openDatabase(file);
    db.sqlite.run(
      "INSERT INTO sessions (id, source, cwd, created_at, updated_at) VALUES ('s1', 'hamness', '/w', 1, 1)",
    );
    expect(() =>
      db.sqlite.run(
        "INSERT INTO tasks (id, session_id, goal, outcome, created_at, updated_at) VALUES ('t1', 's1', 'g', 'done', 1, 1)",
      ),
    ).toThrow();
    db.close();
  });

  test("enforces foreign keys", () => {
    const db = openDatabase(file);
    expect(() =>
      db.sqlite.run(
        "INSERT INTO tasks (id, session_id, goal, outcome, created_at, updated_at) VALUES ('t1', 'missing', 'g', 'open', 1, 1)",
      ),
    ).toThrow();
    db.close();
  });

  test("refuses a database written by a newer hamness", () => {
    const db = openDatabase(file);
    db.sqlite.run(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 1)",
    );
    db.close();
    expect(() => openDatabase(file)).toThrow(/newer/);
  });
});
