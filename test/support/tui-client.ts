import type { SessionCommands } from "../../src/client/client.ts";

/** Session commands for a fake TUI client whose test doesn't use them: each one rejects. */
export function noCommands(): SessionCommands {
  const no = (name: string) => () => Promise.reject(new Error(`${name} is not in this test`));
  return {
    newSession: no("newSession"),
    listSessions: no("listSessions"),
    resume: no("resume"),
    fork: no("fork"),
    compact: no("compact"),
    status: no("status"),
    thinking: no("thinking"),
    setThinking: no("setThinking"),
    rename: no("rename"),
    exportSession: no("exportSession"),
    lastReply: no("lastReply"),
    mode: no("mode"),
    setMode: no("setMode"),
    compat: no("compat"),
  };
}
