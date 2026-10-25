import { newId } from "../db/ids.ts";
import type { HamnessDb } from "../db/open.ts";
import type { SafetyMode } from "../events/types.ts";

/** Where a verdict came from (GLOSSARY: Decision). */
export type DecisionSource = "rule" | "judge" | "hook" | "user" | "mode";

export interface DecisionRecord {
  sessionId: string;
  toolCallId: string;
  tool: string;
  /** Must already be redacted. */
  args: Record<string, unknown>;
  verdict: "allow" | "ask" | "deny";
  source: DecisionSource;
  reason: string;
  /** The rule that decided, e.g. `default: bash rm -rf *`. */
  rule?: string;
  mode?: SafetyMode;
  latencyMs: number;
  category?: string;
  costMicros?: number;
}

export interface DecisionRow {
  id: string;
  sessionId: string | null;
  toolCallId: string | null;
  tool: string;
  args: Record<string, unknown>;
  verdict: "allow" | "ask" | "deny";
  source: DecisionSource;
  reason: string | null;
  rule: string | null;
  mode: string | null;
  latencyMs: number | null;
  costMicros: number;
  createdAt: number;
}

/** The audit log: one row per verdict, including each step of an ask (the ask, then the answer). */
export class DecisionStore {
  constructor(private readonly db: HamnessDb) {}

  add(d: DecisionRecord): string {
    const id = newId();
    const now = Date.now();
    this.db.sqlite
      .query(
        `INSERT INTO decisions (id, session_id, tool_call_id, tool, args_json, verdict, source,
           reason, rule, mode, category, latency_ms, cost_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.sessionId,
        d.toolCallId,
        d.tool,
        JSON.stringify(d.args),
        d.verdict,
        d.source,
        d.reason,
        d.rule ?? null,
        d.mode ?? null,
        d.category ?? null,
        Math.max(0, Math.round(d.latencyMs)),
        d.costMicros ?? 0,
        now,
        now,
      );
    return id;
  }

  /** Newest first. `session` matches a full session id or its end (as `hamness audit` prints it). */
  list(opts: { session?: string; limit?: number } = {}): DecisionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 10_000));
    const where = opts.session ? "WHERE session_id = ?1 OR session_id LIKE '%' || ?1" : "";
    const rows = this.db.sqlite
      .query<
        {
          id: string;
          session_id: string | null;
          tool_call_id: string | null;
          tool: string;
          args_json: string | null;
          verdict: DecisionRow["verdict"];
          source: DecisionSource;
          reason: string | null;
          rule: string | null;
          mode: string | null;
          latency_ms: number | null;
          cost_micros: number;
          created_at: number;
        },
        [string] | []
      >(`SELECT * FROM decisions ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
      .all(...((opts.session ? [opts.session] : []) as [string]));
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      toolCallId: r.tool_call_id,
      tool: r.tool,
      args: r.args_json ? (JSON.parse(r.args_json) as Record<string, unknown>) : {},
      verdict: r.verdict,
      source: r.source,
      reason: r.reason,
      rule: r.rule,
      mode: r.mode,
      latencyMs: r.latency_ms,
      costMicros: r.cost_micros,
      createdAt: r.created_at,
    }));
  }
}

/**
 * A decision's call as one line: the command, path, pattern or URL, else the arguments as JSON
 * (already redacted when stored). Cut to `max` characters with an ellipsis; `Infinity` keeps it.
 * `hamness audit` and the dashboard print the same text.
 */
export function callText(args: Record<string, unknown>, max = 60): string {
  const main = ["command", "path", "file_path", "pattern", "url"].find(
    (k) => typeof args[k] === "string",
  );
  const raw = main ? String(args[main]) : JSON.stringify(args);
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
