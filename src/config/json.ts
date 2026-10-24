import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One JSON object file: hamness's and Claude Code's config files are all this shape. */
export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Reads a file that must hold one JSON object. Undefined when the file is missing; throws
 * `<path>: not valid JSON (...)` or `<path>: must hold a JSON object` otherwise.
 */
export function readJson(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(parsed)) throw new Error(`${path}: must hold a JSON object`);
  return parsed;
}

/** `readJson` that never throws: a broken file reads as missing, and `onError` hears why. */
export function readJsonOr(path: string, onError?: (message: string) => void): Json | undefined {
  try {
    return readJson(path);
  } catch (err) {
    onError?.((err as Error).message);
    return undefined;
  }
}

/**
 * Writes pretty JSON through a temp file and a rename, so readers never see half a file.
 * Folders it has to create are owner-only (0700) when the file is (S-M7: the data dir).
 */
export function writeJsonAtomic(path: string, value: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, ...((mode & 0o077) === 0 ? { mode: 0o700 } : {}) });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
