import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { dataPaths } from "../../config/paths.ts";
import { openDatabase } from "../../db/open.ts";
import { callText, DecisionStore } from "../../safety/decisions.ts";
import type { CliContext } from "../run.ts";

export const AUDIT_USAGE = [
  "Usage: hamness audit [--session <id>] [--limit <n>] [--json]",
  "",
  "Lists recent safety decisions, newest first: what each tool call was,",
  "whether it was allowed, asked or denied, by what (rule, judge, hook, user, mode) and why.",
  "",
  "  --session <id>  Only this session: its full id, or any unique start or end of it",
  "                  (the short id shown here is its last 8 characters)",
  "  --limit <n>     How many decisions (default 50)",
  "  --json          Print the rows as JSON",
].join("\n");

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const two = (n: number) => String(n).padStart(2, "0");

function time(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function latency(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The one session whose id is `given`, starts with it or ends with it. `none` or `several`
 * when that is not one session. Matches sessions and decisions both, so a row is never missed.
 */
function resolveSession(
  db: ReturnType<typeof openDatabase>,
  given: string,
): { id: string } | "none" | "several" {
  const ids = db.sqlite
    .query<{ id: string }, [string]>(
      `SELECT id FROM sessions
         WHERE id = ?1 OR substr(id, 1, length(?1)) = ?1 OR substr(id, -length(?1)) = ?1
       UNION
       SELECT DISTINCT session_id FROM decisions
         WHERE session_id = ?1 OR substr(session_id, 1, length(?1)) = ?1
           OR substr(session_id, -length(?1)) = ?1`,
    )
    .all(given)
    .map((r) => r.id);
  if (ids.includes(given)) return { id: given };
  if (ids.length === 0) return "none";
  return ids.length === 1 ? { id: ids[0] as string } : "several";
}

export async function auditCommand({ args, dataDir, io }: CliContext): Promise<number> {
  let values: { session?: string; limit?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(`hamness audit: ${(e as Error).message}`);
    io.err(AUDIT_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(AUDIT_USAGE);
    return 0;
  }
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    io.err("hamness audit: --limit must be a whole number above 0");
    return 2;
  }

  const path = dataPaths(dataDir).database;
  if (!existsSync(path)) {
    io.out(values.json ? "[]" : "No decisions yet.");
    return 0;
  }
  const db = openDatabase(path);
  try {
    let session: string | undefined;
    if (values.session !== undefined) {
      const given = values.session.trim();
      const found = given ? resolveSession(db, given) : "none";
      if (found === "none") {
        io.err(`hamness audit: no session matches ${values.session}`);
        return 1;
      }
      if (found === "several") {
        io.err(`hamness audit: ${given} matches several sessions`);
        return 1;
      }
      session = found.id;
    }
    const rows = new DecisionStore(db).list({ limit, ...(session ? { session } : {}) });
    if (values.json) {
      io.out(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      io.out("No decisions yet.");
      return 0;
    }
    io.out(
      `${pad("TIME", 19)}  ${pad("SESSION", 8)}  ${pad("TOOL", 10)}  ${pad("VERDICT", 7)}  ${pad("SOURCE", 6)}  ${pad("TOOK", 6)}  CALL / WHY`,
    );
    for (const r of rows) {
      io.out(
        `${time(r.createdAt)}  ${pad((r.sessionId ?? "").slice(-8), 8)}  ${pad(r.tool, 10)}  ${pad(r.verdict, 7)}  ${pad(r.source, 6)}  ${pad(latency(r.latencyMs), 6)}  ${callText(r.args)}`,
      );
      const why = [
        r.reason,
        r.rule ? `(${r.rule})` : "",
        r.source === "judge" && r.judgeModel ? `(judge ${r.judgeModel})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (why) io.out(`${" ".repeat(19 + 2 + 8 + 2)}  ↳ ${why}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
