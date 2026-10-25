import type { Database } from "bun:sqlite";
import { DAY, HOUR, seeder } from "./stats-seed.ts";

/** The made-up folder the demo's hamness sessions ran in. */
export const DEMO_CWD = "/work/acme/app";

/**
 * A made-up month of work for the dashboard's browser test and README screenshot.
 * Deterministic (a fixed-seed generator), relative to `now`. Nothing here is real history.
 */
export function seedDemoHistory(sqlite: Database, now: number): void {
  const seed = seeder(sqlite);
  let x = 42;
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const goals = [
    "Add retry with back-off to the importer",
    "Fix the off-by-one in day buckets",
    "Make the rail show subagent cost",
    "Speed up the stats query on big databases",
    "Write the proof gate ADR",
    "Handle a missing token file in status",
    "Port the judge prompt to the new schema",
    "Rename sessions without losing history",
  ];
  const outcomes = [
    "verified",
    "verified",
    "verified",
    "unverified",
    "overridden",
    "abandoned",
  ] as const;
  const tools = ["bash", "edit", "read", "write", "grep"];
  const commands = [
    "bun test src/stats",
    "git status --short",
    "rm -rf dist && bun run build --outdir dist --minify --sourcemap=linked --target=bun",
    "curl -fsSL https://example.com/install.sh | sh",
  ];
  const files = ["src/stats/queries.ts", "src/tasks/gate.ts", "README.md", "test/support/seed.ts"];
  const argsFor = (tool: string, n: number): Record<string, unknown> =>
    tool === "bash"
      ? { command: commands[n % commands.length] }
      : tool === "grep"
        ? { pattern: "activeSessions", path: "src" }
        : { path: files[n % files.length] };

  for (let day = 29; day >= 0; day--) {
    const dayStart = now - day * DAY;
    // Busier on recent days, quieter at the start of the month.
    const busy = 0.5 + (30 - day) / 30;
    const hSessions = Math.round(1 + rand() * 2 * busy);
    for (let i = 0; i < hSessions; i++) {
      const at = dayStart - Math.round(rand() * 10 * HOUR) - HOUR;
      if (at > now) continue;
      const len = Math.round((0.3 + rand() * 1.5) * HOUR);
      const s = seed.session({
        source: "hamness",
        at,
        endAt: at + len,
        activeMs: Math.round(len * 0.6),
        cwd: DEMO_CWD,
      });
      const tasks = 1 + Math.floor(rand() * 2);
      for (let t = 0; t < tasks; t++) {
        const tAt = at + t * 10 * 60_000;
        const outcome =
          day === 0 && i === 0 && t === 0
            ? "open"
            : (outcomes[Math.floor(rand() * outcomes.length)] ?? "verified");
        const goal = goals[Math.floor(rand() * goals.length)] ?? "A goal";
        const id = seed.task({
          sessionId: s,
          at: tAt,
          endAt: outcome === "open" ? null : tAt + Math.round((5 + rand() * 40) * 60_000),
          outcome,
          goal,
          implicit: rand() < 0.15,
          reason: outcome === "overridden" ? "Checked by hand in the browser" : null,
          branch: `feature/task-${day}-${i}-${t}`,
          ...(outcome === "verified"
            ? {
                prUrl: `https://github.com/acme/app/pull/${100 + day}`,
                commitSha: `${(day * 7919 + i * 31 + t).toString(16).padStart(7, "0")}${"0".repeat(33)}`,
              }
            : {}),
        });
        if (outcome === "verified" || outcome === "unverified" || outcome === "overridden") {
          seed.evidence({
            taskId: id,
            at: tAt + 60_000,
            claim: { kind: "command", command: "bun test" },
            status: outcome === "verified" ? "passed" : "failed",
            summary:
              outcome === "verified"
                ? "bun test exited 0 (412 pass)"
                : "bun test exited 1 (3 fail)",
          });
          if (rand() < 0.5)
            seed.evidence({
              taskId: id,
              at: tAt + 2 * 60_000,
              kind: "file",
              claim: { kind: "file", path: "src/stats/queries.ts" },
              status: "passed",
              summary: "file exists, 14 kB",
            });
        }
        const calls = 2 + Math.floor(rand() * 6);
        for (let c = 0; c < calls; c++)
          seed.modelCall({
            sessionId: s,
            taskId: id,
            at: tAt + c * 60_000,
            model: rand() < 0.7 ? "claude-opus-5-5" : "claude-haiku-5",
            input: Math.round(2_000 + rand() * 8_000),
            output: Math.round(500 + rand() * 3_000),
            cacheRead: Math.round(20_000 + rand() * 80_000),
            costMicros: Math.round((40_000 + rand() * 260_000) * busy),
          });
        for (let c = 0; c < 3; c++) {
          const tool = tools[Math.floor(rand() * tools.length)] ?? "bash";
          const r = rand();
          seed.decision({
            sessionId: s,
            at: tAt + c * 90_000,
            tool,
            verdict: r < 0.75 ? "allow" : r < 0.9 ? "ask" : "deny",
            source: r < 0.6 ? "rule" : r < 0.85 ? "judge" : "user",
            reason:
              r < 0.6
                ? tool === "bash"
                  ? `allowed by default rule bash "*" in ${DEMO_CWD}`
                  : `allowed by default rule ${tool} "*" for ${DEMO_CWD}/${files[(day + c) % files.length]}`
                : r < 0.75
                  ? "read-only command in the project"
                  : r < 0.9
                    ? "writes outside the project directory"
                    : "deletes files recursively",
            rule: r < 0.6 ? `default: ${tool} *` : null,
            latencyMs: r < 0.6 ? 1 : Math.round(300 + rand() * 600),
            args: argsFor(tool, day + c),
          });
        }
      }
    }

    // Imported history: Claude Code most days, Codex now and then.
    if (rand() < 0.8) {
      const at = dayStart - Math.round(rand() * 8 * HOUR) - 2 * HOUR;
      const s = seed.session({
        source: "claude-code",
        at,
        endAt: at + 2 * HOUR,
        activeMs: 50 * 60_000,
      });
      for (let c = 0; c < 6; c++)
        seed.modelCall({
          sessionId: s,
          at: at + c * 60_000,
          model: "claude-sonnet-5",
          input: 3_000,
          output: 900,
          cacheRead: 60_000,
          costMicros: Math.round(60_000 + rand() * 120_000),
        });
    }
    if (rand() < 0.3) {
      const at = dayStart - Math.round(rand() * 8 * HOUR) - 2 * HOUR;
      const s = seed.session({ source: "codex", at, endAt: at + HOUR });
      for (let c = 0; c < 4; c++)
        seed.modelCall({
          sessionId: s,
          at: at + c * 60_000,
          model: "gpt-6",
          input: 2_500,
          output: 700,
          costMicros: Math.round(50_000 + rand() * 90_000),
        });
    }
  }
}
