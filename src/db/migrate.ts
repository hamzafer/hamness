import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations/types.ts";

export function currentVersion(sqlite: Database): number {
  const row = sqlite
    .query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migrations")
    .get();
  return row?.v ?? 0;
}

/** Applies pending migrations, each in its own transaction. Safe to call on every start. */
export function migrate(sqlite: Database, migrations: readonly Migration[]): number {
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`migration ${m.name} has version ${m.version}, expected ${i + 1}`);
  });

  const current = currentVersion(sqlite);
  const latest = migrations.length;
  if (current > latest) {
    throw new Error(
      `database schema is version ${current}, newer than this hamness (${latest}); upgrade hamness`,
    );
  }

  const record = sqlite.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of migrations.slice(current)) {
    sqlite.transaction(() => {
      sqlite.run(m.sql);
      record.run(m.version, m.name, Date.now());
    })();
  }
  return currentVersion(sqlite);
}
