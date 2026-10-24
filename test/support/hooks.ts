import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "hook.ts");

/** Writes Claude Code settings with fixture hooks, and reads back what the hooks were given. */
export function hookFixture(dir: string) {
  const log = join(dir, "hooks.log");
  const responses = join(dir, "hook-responses.json");
  const command = `"${process.execPath}" "${SCRIPT}" "${log}" "${responses}"`;
  return {
    command,
    /** `{ "<event>": [{ matcher?, timeout?, command? }] }`, written to `<settingsDir>/<file>`. */
    settings(
      settingsDir: string,
      events: Record<string, Array<{ matcher?: string; timeout?: number; command?: string }>>,
      file = "settings.json",
      extra: Record<string, unknown> = {},
    ) {
      mkdirSync(settingsDir, { recursive: true });
      const hooks = Object.fromEntries(
        Object.entries(events).map(([event, groups]) => [
          event,
          groups.map((g) => ({
            ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
            hooks: [
              {
                type: "command",
                command: g.command ?? command,
                ...(g.timeout !== undefined ? { timeout: g.timeout } : {}),
              },
            ],
          })),
        ]),
      );
      writeFileSync(join(settingsDir, file), JSON.stringify({ ...extra, hooks }));
    },
    respond(
      answers: Record<
        string,
        { exit?: number; stdout?: unknown; stderr?: string; sleepMs?: number }
      >,
    ) {
      writeFileSync(responses, JSON.stringify(answers));
    },
    calls(): Array<{ input: Record<string, unknown>; cwd: string; projectDir?: string }> {
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
