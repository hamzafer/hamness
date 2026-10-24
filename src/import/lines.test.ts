import { describe, expect, test } from "bun:test";
import { splitLines } from "./lines.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(chunks: Uint8Array[], start = 0, final = false) {
  const out = [];
  for await (const l of splitLines(chunks, start, final)) out.push(l);
  return out;
}

describe("splitLines", () => {
  test("offsets count bytes, also for multi-byte text split across chunks", async () => {
    const bytes = enc("é✓\nab\n");
    // Cut inside the 3-byte check mark.
    const lines = await collect([bytes.subarray(0, 3), bytes.subarray(3)]);
    expect(lines).toEqual([
      { text: "é✓", end: 6 },
      { text: "ab", end: 9 },
    ]);
  });

  test("holds back an unfinished last line unless final", async () => {
    expect(await collect([enc("a\nhalf")], 10)).toEqual([{ text: "a", end: 12 }]);
    expect(await collect([enc("a\nhalf")], 10, true)).toEqual([
      { text: "a", end: 12 },
      { text: "half", end: 16 },
    ]);
  });
});
