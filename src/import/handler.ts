import { basename } from "node:path";
import type { ImportStore } from "./store.ts";

// biome-ignore lint/suspicious/noExplicitAny: source lines are untyped JSON, read defensively
export type Json = any;

/** Turns the lines of one source file into store writes. */
export interface LineHandler {
  /** Returns false to stop reading this file (e.g. a format we don't import). */
  line(obj: Json): boolean;
  /** Flushes per-file totals. The handler's `state` is saved with the file cursor. */
  finish(): void;
}

/** Persisted between runs with the file cursor, so an incremental read can continue. */
export interface HandlerState {
  sessionId?: string;
  agentId?: string;
  model?: string;
  provider?: string;
  /** A Codex thread spawned by another thread. */
  subagent?: boolean;
  /** Active time this file has added to its session, undone if the file is re-read from 0. */
  activeMs?: number;
  /** This file is in a format we don't import. */
  skipped?: boolean;
}

export interface HandlerContext {
  store: ImportStore;
  path: string;
  state: HandlerState;
}

/** We keep the project's folder name only, never the full path (ADR 0009). */
export function projectName(cwd: unknown): string {
  return typeof cwd === "string" && cwd !== "" ? basename(cwd) : "";
}

export function timestampOf(obj: Json): number | null {
  const t = typeof obj?.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tracks the time span, last model and active time a file contributes. */
export class Span {
  first: number | null = null;
  last: number | null = null;
  model: string | null = null;
  activeMs = 0;

  see(at: number | null): void {
    if (at === null) return;
    if (this.first === null || at < this.first) this.first = at;
    if (this.last === null || at > this.last) this.last = at;
  }
}
