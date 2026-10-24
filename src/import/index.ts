/**
 * Import: read-only parsers for Claude Code and Codex history into the same
 * tables, marked with their source. Stores counts, tokens, models, tools and
 * timings, never message text (ADR 0007, ADR 0009).
 *
 * Incremental: each file's byte offset, size and mtime live in `import_files`,
 * so a re-run skips unchanged files and reads only lines appended since.
 * Source files are only ever opened for reading.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HamnessDb } from "../db/open.ts";
import { claudeHandler } from "./claude.ts";
import { codexHandler } from "./codex.ts";
import type { HandlerState, Json, LineHandler } from "./handler.ts";
import { readFileLines } from "./lines.ts";
import { type ImportSource, ImportStore } from "./store.ts";

export interface ImportOptions {
  /** Claude Code config dirs (each holds `projects/`). */
  claudeDirs: readonly string[];
  /** Codex homes (each holds `sessions/`, `archived_sessions/`). */
  codexDirs: readonly string[];
}

export interface ImportSummary {
  files: { read: number; unchanged: number; skipped: number; failed: number };
  lines: number;
  badLines: number;
  added: { sessions: number; agents: number; modelCalls: number; toolCalls: number };
  ms: number;
}

interface SourceFile {
  source: ImportSource;
  path: string;
}

const COUNTED = {
  sessions: "sessions",
  agents: "agents",
  modelCalls: "model_calls",
  toolCalls: "tool_calls",
} as const;

function scan(dir: string, patterns: string[]): string[] {
  if (!existsSync(dir)) return [];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true })) {
      found.add(join(dir, rel));
    }
  }
  return [...found].sort();
}

/** Every history file under the given dirs, main sessions before their subagents. */
export function findHistoryFiles(opts: ImportOptions): SourceFile[] {
  const files: SourceFile[] = [];
  for (const dir of opts.claudeDirs) {
    const projects = join(dir, "projects");
    for (const path of scan(projects, ["*/*.jsonl"])) files.push({ source: "claude-code", path });
    for (const path of scan(projects, ["*/*/subagents/agent-*.jsonl"]))
      files.push({ source: "claude-code", path });
  }
  for (const dir of opts.codexDirs) {
    for (const sub of ["sessions", "archived_sessions"]) {
      for (const path of scan(join(dir, sub), ["**/rollout-*.jsonl", "**/rollout-*.jsonl.zst"]))
        files.push({ source: "codex", path });
    }
  }
  return files;
}

const hashPath = (path: string) => new Bun.CryptoHasher("sha256").update(path).digest("hex");

function counts(db: HamnessDb) {
  const out = {} as Record<keyof typeof COUNTED, number>;
  for (const [key, table] of Object.entries(COUNTED)) {
    out[key as keyof typeof COUNTED] =
      db.sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
  }
  return out;
}

export async function importHistory(db: HamnessDb, opts: ImportOptions): Promise<ImportSummary> {
  const started = performance.now();
  const store = new ImportStore(db.sqlite);
  const before = counts(db);
  const summary: ImportSummary = {
    files: { read: 0, unchanged: 0, skipped: 0, failed: 0 },
    lines: 0,
    badLines: 0,
    added: { sessions: 0, agents: 0, modelCalls: 0, toolCalls: 0 },
    ms: 0,
  };

  for (const file of findHistoryFiles(opts)) {
    const outcome = await importFile(db, store, file, summary);
    summary.files[outcome]++;
  }

  const after = counts(db);
  for (const key of Object.keys(COUNTED) as (keyof typeof COUNTED)[]) {
    summary.added[key] = after[key] - before[key];
  }
  summary.ms = Math.round(performance.now() - started);
  return summary;
}

async function importFile(
  db: HamnessDb,
  store: ImportStore,
  file: SourceFile,
  summary: ImportSummary,
): Promise<keyof ImportSummary["files"]> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file.path);
  } catch {
    return "failed"; // gone since the scan
  }
  const size = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);
  const pathHash = hashPath(file.path);
  const cursor = store.cursor(pathHash);
  if (cursor && cursor.size === size && cursor.mtimeMs === mtimeMs) {
    return cursor.state.skipped ? "skipped" : "unchanged";
  }

  db.sqlite.run("BEGIN");
  try {
    let state: HandlerState = cursor?.state ?? {};
    let offset = cursor?.offset ?? 0;
    // A plain file smaller than where we stopped was rewritten: start over.
    if (!file.path.endsWith(".zst") && size < offset) offset = 0;
    const read = await readFileLines(file.path, offset);
    if (read.start !== (cursor?.offset ?? 0)) {
      // Undo the active time this file added before; every row is an upsert.
      if (state.sessionId && state.activeMs) {
        store.touchSession(state.sessionId, {
          first: null,
          last: null,
          model: null,
          activeMs: -state.activeMs,
        });
      }
      state = {};
    }
    offset = read.start;

    let handler: LineHandler | undefined;
    if (!state.skipped) {
      const ctx = { store, path: file.path, state };
      handler = file.source === "claude-code" ? claudeHandler(ctx) : codexHandler(ctx);
    }
    if (handler) {
      for await (const line of read.lines) {
        offset = line.end;
        if (line.text.trim() === "") continue;
        summary.lines++;
        let obj: Json;
        try {
          obj = JSON.parse(line.text);
        } catch {
          summary.badLines++;
          continue;
        }
        if (!handler.line(obj)) {
          offset = Math.max(offset, size);
          break;
        }
      }
      handler.finish();
    }
    store.saveCursor(file.source, pathHash, { offset, size, mtimeMs, state });
    db.sqlite.run("COMMIT");
    return state.skipped ? "skipped" : "read";
  } catch {
    db.sqlite.run("ROLLBACK");
    return "failed";
  }
}
