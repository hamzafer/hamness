import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations/types.ts";

export function currentVersion(sqlite: Database): number {
  const row = sqlite
    .query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migrations")
    .get();
  return row?.v ?? 0;
}

/**
 * Applies every migration not yet recorded, in version order, each in its own transaction.
 * Safe to call on every start. Versions must ascend but may have gaps: tickets claim numbers
 * up front and land in any order, so a lower version can arrive after a higher one ran.
 */
export function migrate(sqlite: Database, migrations: readonly Migration[]): number {
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  migrations.forEach((m, i) => {
    const prev = migrations[i - 1];
    if (m.version < 1 || (prev && m.version <= prev.version)) {
      throw new Error(`migration ${m.name} has version ${m.version}: versions must be ascending`);
    }
  });

  const known = new Set(migrations.map((m) => m.version));
  const done = new Set(
    sqlite
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );
  const unknown = [...done].filter((v) => !known.has(v));
  if (unknown.length > 0) {
    throw new Error(
      `database has schema migration ${Math.max(...unknown)}, newer than this hamness; upgrade hamness`,
    );
  }

  const record = sqlite.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    sqlite.transaction(() => {
      sqlite.run(m.sql);
      record.run(m.version, m.name, Date.now());
    })();
  }
  return currentVersion(sqlite);
}
