/** One line of a JSONL file and the byte offset just past its newline. */
export interface Line {
  text: string;
  end: number;
}

const NEWLINE = 10;
const decoder = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Splits a byte stream into lines, tracking byte offsets (not string indexes,
 * so multi-byte UTF-8 stays exact). `start` is the offset of the first chunk.
 * A trailing line without a newline is held back unless `final` is set,
 * because a live session file may still be mid-write.
 */
export async function* splitLines(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  start: number,
  final = false,
): AsyncGenerator<Line> {
  let pos = start;
  let pending: Uint8Array[] = [];
  for await (const chunk of chunks) {
    let from = 0;
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, from)) {
      pending.push(chunk.subarray(from, i));
      const bytes = concat(pending);
      pending = [];
      pos += bytes.length + 1;
      from = i + 1;
      yield { text: decoder.decode(bytes), end: pos };
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
  }
  if (final && pending.length > 0) {
    const bytes = concat(pending);
    yield { text: decoder.decode(bytes), end: pos + bytes.length };
  }
}

/**
 * Lines of a file from `start`, read-only. `.zst` files (Codex archives) are
 * decompressed in memory; their offsets count decompressed bytes. Returns the
 * offset actually used: 0 when a `.zst` file shrank below `start`.
 */
export async function readFileLines(
  path: string,
  start: number,
): Promise<{ lines: AsyncGenerator<Line>; start: number }> {
  const file = Bun.file(path);
  if (path.endsWith(".zst")) {
    const bytes = Bun.zstdDecompressSync(await file.bytes());
    const from = start <= bytes.length ? start : 0;
    return { lines: splitLines([bytes.subarray(from)], from, true), start: from };
  }
  return { lines: splitLines(file.slice(start).stream(), start), start };
}
