import { isAbsolute, resolve } from "node:path";

/**
 * Pi's tools in Claude Code's terms, so hooks written for Claude Code match and read the input
 * they expect. Claude Code names (`Bash`, `Read`, ...) and keys (`file_path`, `old_string`, ...)
 * on one side; Pi names (`bash`, `read`, ...) and keys (`path`, `oldText`, ...) on the other.
 * File paths are absolute, as in Claude Code. Tools Pi and Claude Code don't share (MCP, custom)
 * pass through unchanged.
 */

type Args = Record<string, unknown>;

export interface ClaudeCall {
  toolName: string;
  toolInput: Args;
}

/** Pi tool name to Claude Code tool name. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

export const claudeToolName = (piTool: string) => CLAUDE_TOOL_NAMES[piTool] ?? piTool;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function absolute(path: unknown, cwd: string): string {
  const p = str(path);
  if (!p) return cwd;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Drops undefined values, so the input has only the keys that were set. */
function defined(o: Args): Args {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function toClaudeCall(piTool: string, args: Args, cwd: string): ClaudeCall {
  const toolName = claudeToolName(piTool);
  switch (piTool) {
    case "bash":
      return {
        toolName,
        toolInput: defined({
          command: args.command,
          timeout: typeof args.timeout === "number" ? args.timeout * 1000 : undefined,
        }),
      };
    case "read":
      return {
        toolName,
        toolInput: defined({
          file_path: absolute(args.path, cwd),
          offset: args.offset,
          limit: args.limit,
        }),
      };
    case "write":
      return {
        toolName,
        toolInput: { file_path: absolute(args.path, cwd), content: args.content },
      };
    case "edit": {
      const edits = (Array.isArray(args.edits) ? args.edits : []) as Array<{
        oldText?: unknown;
        newText?: unknown;
      }>;
      const first = edits[0];
      return {
        toolName,
        toolInput: defined({
          file_path: absolute(args.path, cwd),
          old_string: first?.oldText,
          new_string: first?.newText,
          replace_all: false,
          edits:
            edits.length > 1
              ? edits.map((e) => ({ old_string: e.oldText, new_string: e.newText }))
              : undefined,
        }),
      };
    }
    case "grep":
      return {
        toolName,
        toolInput: defined({
          pattern: args.pattern,
          path: absolute(args.path, cwd),
          glob: args.glob,
          "-i": args.ignoreCase,
          "-C": args.context,
          head_limit: args.limit,
          output_mode: "content",
        }),
      };
    case "find":
      return {
        toolName,
        toolInput: { pattern: args.pattern, path: absolute(args.path, cwd) },
      };
    case "ls":
      return { toolName, toolInput: { path: absolute(args.path, cwd) } };
    default:
      return { toolName, toolInput: args };
  }
}

/** A tool's result as `tool_response`: Bash's shape for bash, the file and output for the rest. */
export function toClaudeResponse(piTool: string, args: Args, output: string, cwd: string): Args {
  if (piTool === "bash") return { stdout: output, stderr: "", interrupted: false, isImage: false };
  const filePath = ["read", "write", "edit"].includes(piTool)
    ? absolute(args.path, cwd)
    : undefined;
  return defined({ filePath, output });
}
