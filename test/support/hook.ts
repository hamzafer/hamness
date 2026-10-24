/**
 * A fixture Claude Code command hook: `bun hook.ts <log> [responses]`.
 * Appends what it was given (stdin JSON, cwd, CLAUDE_PROJECT_DIR) to <log> as one JSON line,
 * then answers as <responses> says for the event: `{ "<event>": { exit, stdout, stderr, sleepMs } }`
 * (`stdout` may be an object, printed as JSON).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [log, responses] = process.argv.slice(2);
const input = JSON.parse(await Bun.stdin.text()) as { hook_event_name: string };
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ input, cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR })}\n`,
  );
}
const all =
  responses && existsSync(responses)
    ? (JSON.parse(readFileSync(responses, "utf8")) as Record<string, Answer>)
    : {};

interface Answer {
  exit?: number;
  stdout?: unknown;
  stderr?: string;
  sleepMs?: number;
}
const a = all[input.hook_event_name] ?? {};
if (a.sleepMs) await Bun.sleep(a.sleepMs);
if (a.stdout !== undefined) {
  process.stdout.write(typeof a.stdout === "string" ? a.stdout : JSON.stringify(a.stdout));
}
if (a.stderr) process.stderr.write(a.stderr);
process.exit(a.exit ?? 0);
