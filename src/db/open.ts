import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
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
  let sqlite: Database;
  try {
    // Owner-only: SQLite gives the -wal and -shm files the database file's mode.
    if (path !== ":memory:") {
      closeSync(openSync(path, "a", 0o600));
      ownerOnly(path);
    }
    sqlite = new Database(path, { create: true, strict: true });
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.run("PRAGMA busy_timeout = 5000");
    migrate(sqlite, migrations);
    // Older installs may have left the WAL files readable by others.
    if (path !== ":memory:") for (const f of [`${path}-wal`, `${path}-shm`]) ownerOnly(f);
  } catch (err) {
    sqlite.close();
    const message = (err as Error).message;
    // "file is not a database" and the like: say which file, and what to do about it.
    if (/not a database|malformed|corrupt/i.test(message)) {
      throw new Error(
        `${path} is not a usable hamness database (${message}); move it aside and run again`,
        { cause: err },
      );
    }
    throw err;
  }
  return {
    sqlite,
    schemaVersion: () => currentVersion(sqlite),
    close: () => sqlite.close(),
  };
}

function ownerOnly(file: string): void {
  if (existsSync(file)) chmodSync(file, 0o600);
}
