import { initial } from "./0001-initial.ts";
import { importTables } from "./0002-import.ts";
import { tasksAndProof } from "./0006-tasks.ts";
import type { Migration } from "./types.ts";

/** Every migration in version order. Append only (versions may have gaps). */
export const migrations: readonly Migration[] = [initial, importTables, tasksAndProof];

/** The schema version a fresh database migrates to. */
export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
