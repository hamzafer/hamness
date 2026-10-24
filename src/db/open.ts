import { Database } from "bun:sqlite";
import { currentVersion, migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

export interface HamnessDb {
  /** The raw handle. Feature modules (tasks, stats, ...) build their queries on it. */
  readonly sqlite: Database;
  schemaVersion(): number;
  close(): void;
}

/** Opens (creating if needed) and migrates the hamness database. */
export function openDatabase(path: string): HamnessDb {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.run("PRAGMA busy_timeout = 5000");
    migrate(sqlite, migrations);
  } catch (err) {
    sqlite.close();
    throw err;
  }
  return {
    sqlite,
    schemaVersion: () => currentVersion(sqlite),
    close: () => sqlite.close(),
  };
}
