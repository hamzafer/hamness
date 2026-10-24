export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /**
   * Reads one secret line without echoing it (prompt on stderr). Piped stdin is read as is.
   * Rejects when the user cancels.
   */
  readSecret?(prompt: string): Promise<string>;
  /** Reads one visible line (prompt on stderr), for login codes and choices. */
  readLine?(prompt: string): Promise<string>;
}

async function readPiped(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  return text.split(/\r?\n/)[0] ?? "";
}

/** Raw-mode read: no echo, Enter ends, Ctrl+C (or Ctrl+D with nothing typed) cancels. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || (ch === "\u0004" && !value)) return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function readVisible(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8").split(/\r?\n/)[0] ?? "");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readSecret: (prompt) => (process.stdin.isTTY ? readHidden(prompt) : readPiped()),
  readLine: (prompt) => (process.stdin.isTTY ? readVisible(prompt) : readPiped()),
};
