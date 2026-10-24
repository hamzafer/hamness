/**
 * A tiny MCP stdio server for tests: newline-delimited JSON-RPC with one tool, `echo`.
 * Run with `bun test/support/mcp-server.ts`. When `MCP_TEST_LOG` is set, each tool call
 * is appended to that file, so a test can tell whether a call reached the server.
 */
import { appendFileSync } from "node:fs";

interface Message {
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: { text?: unknown } };
}

function reply(msg: Message): Record<string, unknown> {
  switch (msg.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "hamness-test", version: "1.0.0" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: [
            {
              name: "echo",
              description: "Echoes the text back",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      };
    case "tools/call": {
      const text = String(msg.params?.arguments?.text ?? "");
      const log = process.env.MCP_TEST_LOG;
      if (log) appendFileSync(log, `${msg.params?.name} ${text}\n`);
      const suffix = process.env.ECHO_SUFFIX ?? "";
      return { result: { content: [{ type: "text", text: `echo: ${text}${suffix}` }] } };
    }
    default:
      return { error: { code: -32601, message: `no method ${msg.method}` } };
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as Message;
    if (msg.id === undefined) continue; // a notification
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply(msg) })}\n`);
  }
});
