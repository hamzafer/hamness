import { initial } from "./0001-initial.ts";
import { importTables } from "./0002-import.ts";
import { safetyDecisions } from "./0003-safety.ts";
import { tasksAndProof } from "./0006-tasks.ts";
import { sessionCommands } from "./0007-session-commands.ts";
import { modelCallBilling } from "./0008-billing.ts";
import { sessionPicks } from "./0009-session-picks.ts";
import type { Migration } from "./types.ts";

/** Every migration in version order. Append only (versions may have gaps). */
export const migrations: readonly Migration[] = [
  initial,
  importTables,
  safetyDecisions,
  tasksAndProof,
  sessionCommands,
  modelCallBilling,
  sessionPicks,
];

/** The schema version a fresh database migrates to. */
export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
