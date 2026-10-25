import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../safety/index.ts";
import { ReplyRedactor } from "./reply-redact.ts";

// Synthetic, obviously fake secret built at run time.
const KEY = `sk-ant-api03-${"a1B2".repeat(10)}`;

/** Feeds `text` in pieces of `size` characters; returns what was sent, flush included. */
function stream(text: string, size: number): string[] {
  const r = new ReplyRedactor();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(r.push(text.slice(i, i + size)));
  out.push(r.flush());
  return out;
}

describe("ReplyRedactor", () => {
  test("a key split across deltas never goes out whole or in part", () => {
    const text = `Here is the key you asked for: ${KEY}. Keep it safe, and rotate it ${"soon ".repeat(30)}`;
    for (const size of [1, 3, 7, 16, 50]) {
      const sent = stream(text, size);
      const joined = sent.join("");
      expect(joined).toBe(redactSecrets(text));
      for (const chunk of sent) expect(chunk).not.toContain("sk-ant-api03-a1B2");
    }
  });

  test("text goes out as it streams, holding back only a short tail", () => {
    const r = new ReplyRedactor();
    const first = r.push(`${"word ".repeat(40)}`);
    expect(first.length).toBeGreaterThan(100);
    expect(r.flush()).toBe("word ".repeat(40).slice(first.length));
  });

  test("a private key block is held until it ends", () => {
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"b3Bl ".repeat(40)}\n-----END OPENSSH PRIVATE KEY-----`;
    const sent = stream(`key:\n${pem}\ndone ${"and more ".repeat(20)}`, 9);
    expect(sent.join("")).not.toContain("b3Bl");
    expect(sent.join("")).toContain("‹redacted› private key");
  });
});
