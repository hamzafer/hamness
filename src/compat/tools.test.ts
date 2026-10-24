import { describe, expect, test } from "bun:test";
import { toClaudeCall, toClaudeResponse } from "./tools.ts";

const cwd = "/work/proj";

describe("Pi tool calls in Claude Code's names and input keys", () => {
  test("bash becomes Bash; its timeout goes from seconds to milliseconds", () => {
    expect(toClaudeCall("bash", { command: "ls -la", timeout: 5 }, cwd)).toEqual({
      toolName: "Bash",
      toolInput: { command: "ls -la", timeout: 5000 },
    });
  });

  test("file tools use an absolute file_path", () => {
    expect(toClaudeCall("read", { path: "src/a.ts", offset: 3, limit: 10 }, cwd)).toEqual({
      toolName: "Read",
      toolInput: { file_path: "/work/proj/src/a.ts", offset: 3, limit: 10 },
    });
    expect(toClaudeCall("write", { path: "/abs/b.ts", content: "x" }, cwd)).toEqual({
      toolName: "Write",
      toolInput: { file_path: "/abs/b.ts", content: "x" },
    });
  });

  test("edit becomes Edit with old_string / new_string (all edits listed when several)", () => {
    expect(
      toClaudeCall("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd),
    ).toEqual({
      toolName: "Edit",
      toolInput: {
        file_path: "/work/proj/a.ts",
        old_string: "a",
        new_string: "b",
        replace_all: false,
      },
    });
    const multi = toClaudeCall(
      "edit",
      {
        path: "a.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      },
      cwd,
    );
    expect(multi.toolInput.edits).toEqual([
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ]);
  });

  test("grep, find and ls become Grep, Glob and LS", () => {
    expect(
      toClaudeCall(
        "grep",
        { pattern: "foo", path: "src", glob: "*.ts", ignoreCase: true, context: 2 },
        cwd,
      ),
    ).toEqual({
      toolName: "Grep",
      toolInput: {
        pattern: "foo",
        path: "/work/proj/src",
        glob: "*.ts",
        "-i": true,
        "-C": 2,
        output_mode: "content",
      },
    });
    expect(toClaudeCall("find", { pattern: "**/*.ts" }, cwd)).toEqual({
      toolName: "Glob",
      toolInput: { pattern: "**/*.ts", path: "/work/proj" },
    });
    expect(toClaudeCall("ls", {}, cwd)).toEqual({
      toolName: "LS",
      toolInput: { path: "/work/proj" },
    });
  });

  test("other tools (MCP, custom) keep their name and input", () => {
    expect(toClaudeCall("mcp__github__list", { q: 1 }, cwd)).toEqual({
      toolName: "mcp__github__list",
      toolInput: { q: 1 },
    });
  });

  test("a Bash result looks like Claude Code's: stdout, stderr, interrupted", () => {
    expect(toClaudeResponse("bash", { command: "ls" }, "a\nb", cwd)).toEqual({
      stdout: "a\nb",
      stderr: "",
      interrupted: false,
      isImage: false,
    });
    expect(toClaudeResponse("write", { path: "a.ts" }, "ok", cwd)).toEqual({
      filePath: "/work/proj/a.ts",
      output: "ok",
    });
  });
});
