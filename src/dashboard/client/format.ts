/** Display formats for the dashboard's tables. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A row's time, short enough to stay on one line: "17:16" today, "Oct 24 09:03" on another day
 * this year, "Dec 30 2025 23:59" before that. Local time.
 */
export function shortWhen(t: number, now = Date.now()): string {
  const d = new Date(t);
  const n = new Date(now);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return time;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear()
    ? `${day} ${time}`
    : `${day} ${d.getFullYear()} ${time}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with paths inside the session folder written relative to it (`src/a.ts`, `.` for the
 * folder itself). Only an absolute `cwd` other than `/` counts; imported sessions keep a folder
 * name (ADR 0009), so their text is left as it is. A sibling such as `<cwd>2/` is not touched.
 */
export function relativeToCwd(text: string, cwd: string | null): string {
  if (!cwd?.startsWith("/")) return text;
  const root = cwd.replace(/\/+$/, "");
  if (!root) return text;
  const r = escapeRegExp(root);
  return text
    .replace(new RegExp(`${r}/(?=[^\\s/"'\`])`, "g"), "")
    .replace(new RegExp(`${r}(?=/|$|[\\s"'\`),;:])`, "g"), ".");
}
