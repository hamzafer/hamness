import { initial } from "./0001-initial.ts";
import { importTables } from "./0002-import.ts";
import type { Migration } from "./types.ts";

/** Every migration in order. Append only. */
export const migrations: readonly Migration[] = [initial, importTables];
