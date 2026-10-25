import type { SessionStatus } from "../agent/session-hub.ts";
import { type DaemonClient, DaemonError, type SessionCommands } from "../client/client.ts";
import type {
  JudgeState,
  SafetyMode,
  SessionInfo,
  SessionSnapshot,
  ThinkingLevel,
} from "../events/types.ts";
import { JUDGE_BACK_ON, type SystemLine } from "./chat-state.ts";
import { plural, shortPath } from "./layout.ts";
import type { PickerSpec } from "./picker.tsx";
import { formatCost } from "./rail-state.ts";
import { parseTaskCommand, taskConfirmation } from "./task-commands.ts";

export type Tone = SystemLine["tone"];

/** What a command can do to the TUI. `app.tsx` implements it. */
export interface CommandContext {
  readonly client: DaemonClient & SessionCommands;
  /** The session as the chat shows it now. */
  session(): SessionInfo;
  /** The home folder, shown as `~`. */
  readonly home: string;
  /** A quiet line in the chat. */
  say(text: string, tone?: Tone): void;
  /** Merges fields into the shown session (header, banner). */
  patchSession(patch: Partial<SessionInfo>): void;
  /** Opens a list the user picks one row from. */
  pick(spec: PickerSpec): void;
  showHelp(): void;
  showStatus(status: SessionStatus): void;
  /** `/model [provider/id]`: the existing picker, or a straight switch. */
  model(arg: string): void;
  /**
   * Switches the chat to the session `call` resolves with (`/new`, `/resume`, `/fork`). While
   * it runs, the old session's `session.replaced` is this client's own doing and is ignored.
   */
  switchTo(
    call: () => Promise<SessionSnapshot>,
    line: (snapshot: SessionSnapshot) => string,
  ): Promise<SessionSnapshot | undefined>;
  /** A failed `/compact`: one readable line, even when its event says it too. */
  compactionFailed(message: string): void;
  /** Puts text in the input box. */
  setInput(text: string): void;
  /** The user's prompts in this chat, oldest first, for `/fork`. */
  prompts(): Array<{ id: string; text: string }>;
  /** `system`: the clipboard has it; `terminal`: sent by OSC 52, which a terminal may ignore. */
  copy(text: string): Promise<"system" | "terminal">;
  exit(): void;
}

export interface SlashCommand {
  /** Without the slash. */
  name: string;
  aliases?: readonly string[];
  /** The argument hint the menu and `/help` show: `<required>` or `[optional]`. */
  args?: string;
  /** One line, sentence case, no full stop. */
  description: string;
  /** Enter in the menu completes the name instead of running it. Default: `args` is `<…>`. */
  needsArgs?: boolean;
  run(ctx: CommandContext, arg: string): void | Promise<void>;
}

/**
 * The daemon's 409 for a session busy with a reply, a compaction or a switch (`/mode`,
 * `/thinking` and `/name` meanwhile, ADR 0021). Its own message talks about prompts only.
 */
export const BUSY_LINE = "Busy with a reply, compaction or switch. Try again in a moment.";

/** The chat line for a failed command call. */
export function errorLine(err: unknown): [string, Tone] {
  if (err instanceof DaemonError && err.status === 409 && /already running/.test(err.message)) {
    return [BUSY_LINE, "warn"];
  }
  return [err instanceof Error ? err.message : String(err), "error"];
}

const fail = (ctx: CommandContext) => (err: unknown) => ctx.say(...errorLine(err));

/** A prompt or a session label on one line, cut to `max` columns. */
export function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86_400) return "yesterday";
  return `${Math.floor(s / 86_400)}d ago`;
}

/**
 * `/export [html|jsonl] [path] [--force]`; a lone path ending in `.jsonl` means jsonl.
 * `--force` replaces a file that is already there.
 */
export function parseExportArgs(arg: string): {
  format: "html" | "jsonl";
  path?: string;
  force?: true;
} {
  // `--force` counts only as the first or the last word, cut out of the text as typed.
  let rest = arg.trim();
  let force = false;
  const head = /^--force(?:\s+|$)/.exec(rest);
  const tail = /(?:^|\s+)--force$/.exec(rest);
  if (head) {
    rest = rest.slice(head[0].length);
    force = true;
  } else if (tail) {
    rest = rest.slice(0, tail.index);
    force = true;
  }
  const out = ((): { format: "html" | "jsonl"; path?: string } => {
    const m = /^(html|jsonl)(?:\s+([\s\S]+))?$/.exec(rest);
    if (m)
      return m[2]
        ? { format: m[1] as "html" | "jsonl", path: m[2].trim() }
        : { format: m[1] as "html" | "jsonl" };
    if (!rest) return { format: "html" };
    return { format: rest.endsWith(".jsonl") ? "jsonl" : "html", path: rest };
  })();
  return force ? { ...out, force: true } : out;
}

/** The daemon's refusal to replace a file (`… exists; send overwrite: true …`), said for the TUI. */
function exportExistsLine(
  err: unknown,
  format: string,
  path: string | undefined,
): string | undefined {
  if (!(err instanceof DaemonError) || err.status !== 409 || !/ exists; /.test(err.message)) {
    return undefined;
  }
  const target = path ?? err.message.slice(0, err.message.indexOf(" exists; "));
  const name = path ?? target.split("/").at(-1) ?? target;
  return `${name} exists. Use /export ${format} ${target} --force to replace it.`;
}

/** `/judge resume` when the judge didn't come back on: still paused, or off for another reason. */
const JUDGE_NOT_ON: Record<Exclude<JudgeState, "on">, string> = {
  paused: "The judge is still paused. Try /judge resume again.",
  "over-budget": "The judge isn't paused: it is over today's budget.",
  "no-key": "The judge isn't paused: it is off without an Anthropic API key.",
};

const MODES: ReadonlyArray<readonly [SafetyMode, string]> = [
  ["ask", "Rules decide, then you"],
  ["auto", "Rules, then the judge, then you"],
  ["yolo", "No questions; deny rules still apply"],
];

function setMode(ctx: CommandContext, mode: SafetyMode) {
  return ctx.client
    .setMode(ctx.session().id, mode)
    .then((r) => {
      ctx.patchSession({ mode: r.mode });
      ctx.say(`Mode: ${r.mode}`, r.mode === "yolo" ? "warn" : "muted");
    })
    .catch(fail(ctx));
}

function setThinking(ctx: CommandContext, level: string) {
  return ctx.client
    .setThinking(ctx.session().id, level as ThinkingLevel)
    .then((r) => {
      ctx.patchSession({ thinkingLevel: r.level });
      ctx.say(`Thinking: ${r.level}`);
    })
    .catch(fail(ctx));
}

/** The line `/new` leaves in the fresh chat. */
function newSessionLine(snap: SessionSnapshot): string {
  return snap.task?.outcome === "open"
    ? `New session. The open task came along: ${oneLine(snap.task.goal, 50)}`
    : "New session.";
}

const sessionLabel = (s: { name?: string; firstPrompt?: string }) =>
  s.name ?? (s.firstPrompt ? oneLine(s.firstPrompt, 44) : "Untitled session");

/**
 * Every slash command, in the order the `/` menu lists them. `/help` is generated from this
 * list, and `submit` in app.tsx runs from it: one place to add a command.
 */
export const COMMANDS: readonly SlashCommand[] = [
  {
    name: "new",
    aliases: ["clear"],
    description: "Start fresh; an open task comes along",
    run: (ctx) => {
      ctx.switchTo(() => ctx.client.newSession(ctx.session().id), newSessionLine);
    },
  },
  {
    name: "compact",
    args: "[instructions]",
    description: "Summarize the context to free up room",
    run: (ctx, arg) => {
      ctx.client.compact(ctx.session().id, arg || undefined).catch((err: unknown) => {
        const [line, tone] = errorLine(err);
        // Busy: the usual try-again line. Else the compaction itself failed, and its event
        // (`agent.compaction.end`) says so too: one line for both.
        if (line === BUSY_LINE) ctx.say(line, tone);
        else ctx.compactionFailed(line);
      });
    },
  },
  {
    name: "resume",
    aliases: ["sessions"],
    description: "Switch to another session in this folder",
    run: async (ctx) => {
      const now = Date.now();
      const sessions = await ctx.client
        .listSessions(ctx.session().cwd, ctx.session().id)
        .catch(fail(ctx));
      if (!sessions) return;
      if (!sessions.some((s) => !s.current)) {
        ctx.say("No other sessions in this folder yet.");
        return;
      }
      ctx.pick({
        title: "Resume a session",
        rows: sessions.map((s) => ({
          cells: [
            sessionLabel(s),
            relativeTime(s.lastActivityAt, now),
            plural(s.messageCount, "message"),
            formatCost(s.costMicros),
          ],
          current: s.current,
          dim: !s.resumable,
        })),
        start: Math.max(
          0,
          sessions.findIndex((s) => !s.current),
        ),
        onPick: (i) => {
          const s = sessions[i];
          if (!s || s.current) return;
          if (!s.resumable) {
            ctx.say("That session can't be resumed: its Pi session file is gone.", "warn");
            return;
          }
          ctx.switchTo(
            () => ctx.client.resume(ctx.session().id, s.id),
            () => `Resumed: ${sessionLabel(s)}`,
          );
        },
      });
    },
  },
  {
    name: "fork",
    description: "Branch off from an earlier prompt",
    run: (ctx) => {
      const prompts = ctx.prompts().slice().reverse();
      if (!prompts.length) {
        ctx.say("Nothing to fork from yet: send a prompt first.");
        return;
      }
      ctx.pick({
        title: "Fork from a prompt",
        rows: prompts.map((p) => ({ cells: [oneLine(p.text, 72)] })),
        onPick: (i) => {
          const p = prompts[i];
          if (!p) return;
          let text = "";
          ctx
            .switchTo(
              async () => {
                const r = await ctx.client.fork(ctx.session().id, p.id);
                text = r.text;
                return r.snapshot;
              },
              () => "Forked. Your prompt is back in the input box.",
            )
            .then((snap) => {
              if (snap) ctx.setInput(text);
            });
        },
      });
    },
  },
  {
    name: "model",
    args: "[provider/id]",
    description: "Switch model; alone, pick from a list",
    run: (ctx, arg) => ctx.model(arg),
  },
  {
    name: "thinking",
    args: "[level]",
    description: "Set how hard the model thinks",
    run: async (ctx, arg) => {
      if (arg) {
        await setThinking(ctx, arg);
        return;
      }
      const got = await ctx.client.thinking(ctx.session().id).catch(fail(ctx));
      if (!got) return;
      ctx.pick({
        title: "Thinking level",
        rows: got.levels.map((l) => ({ cells: [l], current: l === got.level })),
        start: Math.max(0, got.levels.indexOf(got.level)),
        onPick: (i) => {
          const level = got.levels[i];
          if (level) setThinking(ctx, level);
        },
      });
    },
  },
  {
    name: "mode",
    args: "[ask|auto|yolo]",
    description: "Set how tool calls get approved",
    run: (ctx, arg) => {
      if (arg) {
        const mode = MODES.find(([m]) => m === arg)?.[0];
        if (!mode) return ctx.say("Usage: /mode ask|auto|yolo", "warn");
        return void setMode(ctx, mode);
      }
      const current = ctx.session().mode;
      ctx.pick({
        title: "Safety mode",
        rows: MODES.map(([m, what]) => ({ cells: [m, what], current: m === current })),
        start: Math.max(
          0,
          MODES.findIndex(([m]) => m === current),
        ),
        onPick: (i) => {
          const mode = MODES[i]?.[0];
          if (mode) setMode(ctx, mode);
        },
      });
    },
  },
  {
    name: "status",
    aliases: ["cost"],
    description: "Model, context, cost and task",
    run: async (ctx) => {
      const status = await ctx.client.status(ctx.session().id).catch(fail(ctx));
      if (status) ctx.showStatus(status);
    },
  },
  {
    name: "name",
    args: "<name>",
    description: "Name this session",
    run: (ctx, arg) => {
      if (!arg) return ctx.say("Usage: /name <name>", "warn");
      ctx.client
        .rename(ctx.session().id, arg)
        .then((snap) => {
          const name = snap.session.name ?? arg;
          ctx.patchSession({ name });
          ctx.say(`Named: ${name}`);
        })
        .catch(fail(ctx));
    },
  },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard",
    run: async (ctx) => {
      try {
        const text = await ctx.client.lastReply(ctx.session().id);
        if (text === undefined) return ctx.say("Nothing to copy yet.");
        const how = await ctx.copy(text);
        ctx.say(how === "system" ? "Copied." : "Sent to the terminal clipboard.");
      } catch (err) {
        fail(ctx)(err);
      }
    },
  },
  {
    name: "export",
    args: "[html|jsonl] [path]",
    description: "Save the session to a file; --force replaces one",
    run: (ctx, arg) => {
      const { format, path, force } = parseExportArgs(arg);
      ctx.client
        .exportSession(ctx.session().id, format, {
          ...(path ? { path } : {}),
          ...(force ? { overwrite: true } : {}),
        })
        .then((written) => ctx.say(`Exported to ${shortPath(written, ctx.home, 200)}`))
        .catch((err: unknown) => {
          const exists = exportExistsLine(err, format, path);
          if (exists) ctx.say(exists, "warn");
          else fail(ctx)(err);
        });
    },
  },
  {
    name: "task",
    args: "<goal>",
    description: "Open a task, verified by its evidence",
    run: (ctx, arg) => taskCommand(ctx, `/task ${arg}`),
  },
  {
    name: "override",
    args: "[reason]",
    description: "Accept the open task without proof",
    run: (ctx, arg) => taskCommand(ctx, `/override ${arg}`),
  },
  {
    name: "abandon",
    args: "[reason]",
    description: "Drop the open task",
    run: (ctx, arg) => taskCommand(ctx, `/abandon ${arg}`),
  },
  {
    name: "judge",
    args: "resume",
    needsArgs: true,
    description: "Turn a paused judge back on",
    run: (ctx, arg) => {
      if (arg !== "resume") return ctx.say("Usage: /judge resume", "warn");
      const before = ctx.session().judge;
      ctx.client
        .resumeJudge(ctx.session().id)
        .then((judge) => {
          // The judge's own event (`safety.judge`) says "back on" when it gets here first.
          if (judge === "on" && ctx.session().judge === "paused") ctx.say(JUDGE_BACK_ON);
          else if (judge === "on" && before !== "paused") ctx.say("The judge is already on.");
          else if (judge !== "on") ctx.say(JUDGE_NOT_ON[judge], "warn");
          ctx.patchSession({ judge });
        })
        .catch(fail(ctx));
    },
  },
  {
    name: "skills",
    description: "List the skills this session loaded",
    run: async (ctx) => {
      const compat = await ctx.client.compat(ctx.session().id).catch(fail(ctx));
      if (!compat) return;
      if (!compat.skills.length) return ctx.say("No skills loaded.");
      ctx.say(`Skills (${compat.skills.length}):`);
      const width = Math.max(...compat.skills.map((s) => s.name.length)) + 2;
      for (const s of compat.skills) {
        ctx.say(`  ${s.name.padEnd(width)}${oneLine(s.description, 64)}  (${s.scope})`);
      }
    },
  },
  {
    name: "mcp",
    description: "List MCP servers and their state",
    run: async (ctx) => {
      const compat = await ctx.client.compat(ctx.session().id).catch(fail(ctx));
      if (!compat) return;
      if (!compat.mcpServers.length) return ctx.say("No MCP servers configured.");
      ctx.say(`MCP servers (${compat.mcpServers.length}):`);
      const width = Math.max(...compat.mcpServers.map((s) => s.name.length)) + 2;
      for (const s of compat.mcpServers) {
        const why = s.reason ? `: ${oneLine(s.reason, 50)}` : "";
        ctx.say(
          `  ${s.name.padEnd(width)}${s.status}${why}  (${s.scope})`,
          s.reason ? "warn" : "muted",
        );
      }
    },
  },
  {
    name: "help",
    aliases: ["?"],
    description: "Every command and key",
    run: (ctx) => ctx.showHelp(),
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Leave; the session keeps running",
    run: (ctx) => ctx.exit(),
  },
];

function taskCommand(ctx: CommandContext, text: string) {
  const action = parseTaskCommand(text);
  if (!action) return;
  if ("error" in action) return ctx.say(action.error, "warn");
  ctx.client
    .task(ctx.session().id, action)
    .then((task) => ctx.say(taskConfirmation(action, task), "ok"))
    .catch(fail(ctx));
}

export const needsArgs = (c: SlashCommand) => c.needsArgs ?? c.args?.startsWith("<") === true;

export function findCommand(word: string): SlashCommand | undefined {
  const w = word.toLowerCase();
  return COMMANDS.find((c) => c.name === w || c.aliases?.includes(w));
}

/** A row of the `/` menu: the command, shown as `label` (an alias when that is what matched). */
export interface CommandMatch {
  command: SlashCommand;
  label: string;
}

/**
 * How well `query` matches `name`, lower is better: exact, then prefix, then the query's
 * letters in order (fewer gaps first). Undefined: no match.
 */
function score(query: string, name: string): number | undefined {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  let at = -1;
  let gaps = 0;
  for (const ch of query) {
    const i = name.indexOf(ch, at + 1);
    if (i < 0) return undefined;
    if (at >= 0 && i > at + 1) gaps += i - at - 1;
    at = i;
  }
  return 10 + gaps;
}

/** The `/` menu's rows for what follows the slash. Empty query: every command, by name. */
export function matchCommands(query: string): CommandMatch[] {
  const q = query.toLowerCase();
  if (!q) return COMMANDS.map((command) => ({ command, label: `/${command.name}` }));
  const hits: Array<CommandMatch & { score: number; order: number }> = [];
  COMMANDS.forEach((command, order) => {
    let best: { score: number; label: string } | undefined;
    // An alias counts a little less than the name at the same quality.
    for (const [i, n] of [command.name, ...(command.aliases ?? [])].entries()) {
      const s = score(q, n);
      if (s === undefined) continue;
      const weighted = s + (i > 0 ? 0.5 : 0);
      if (!best || weighted < best.score) best = { score: weighted, label: `/${n}` };
    }
    if (best) hits.push({ command, label: best.label, score: best.score, order });
  });
  hits.sort((a, b) => a.score - b.score || a.order - b.order);
  return hits.map(({ command, label }) => ({ command, label }));
}

/**
 * What Enter does in the menu. It runs only what the user clearly meant: an exact name or
 * alias, a prefix that only one command has, or a row picked with the arrows. A fuzzy or
 * shared match completes into the input box instead, and a bare `/` only hints.
 */
export function menuEnter(
  query: string,
  matches: readonly CommandMatch[],
  selected: number,
  navigated: boolean,
): { kind: "run" | "complete"; match: CommandMatch } | { kind: "hint" } {
  const picked = matches[Math.min(selected, matches.length - 1)];
  if (!picked) return { kind: "hint" };
  if (navigated) return { kind: "run", match: picked };
  const q = query.toLowerCase();
  if (!q) return { kind: "hint" };
  const exact = findCommand(q);
  if (exact) return { kind: "run", match: { command: exact, label: `/${q}` } };
  const prefixed = COMMANDS.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(q)),
  );
  const only = prefixed[0];
  if (prefixed.length === 1 && only) {
    const label = [only.name, ...(only.aliases ?? [])].find((n) => n.startsWith(q)) ?? only.name;
    return { kind: "run", match: { command: only, label: `/${label}` } };
  }
  return { kind: "complete", match: picked };
}

/** What follows the slash while the menu should show: the first word, still being typed. */
export function menuQuery(text: string): string | undefined {
  const m = /^\/([^\s]*)$/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * A submitted line: a known command and its argument, an unknown `/word` (a typo, never sent
 * to the model), or undefined for a prompt (plain text, or a path like `/src/x.ts`).
 */
export function parseSlash(
  text: string,
): { command: SlashCommand; arg: string } | { unknown: string } | undefined {
  const t = text.trim();
  if (t === "/") return { unknown: "/" };
  const m = /^\/([a-z?][\w-]*|\?)(?=\s|$)\s*([\s\S]*)$/i.exec(t);
  if (!m) return undefined;
  const word = m[1] ?? "";
  const command = findCommand(word);
  if (!command) return { unknown: `/${word}` };
  return { command, arg: (m[2] ?? "").trim() };
}
