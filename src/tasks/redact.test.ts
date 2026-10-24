import { describe, expect, test } from "bun:test";
import { redactOutput } from "./redact.ts";

describe("redactOutput", () => {
  test("masks secret assignments and well-known key shapes, keeps the rest", () => {
    const out = redactOutput(
      [
        "API_KEY=abc123def456",
        "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
        "aws AKIAABCDEFGHIJKLMNOP",
        "all 12 tests passed",
      ].join("\n"),
      {},
    );
    for (const secret of ["abc123def456", "sk-ant-api03", "AKIAABCDEFGHIJKLMNOP"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("all 12 tests passed");
  });

  test("masks the values of secret-looking environment variables wherever they appear", () => {
    const out = redactOutput("connecting with zq9-synthetic-value-77 now", {
      MY_SERVICE_TOKEN: "zq9-synthetic-value-77",
      HOME_DIR: "/not/secret",
    });
    expect(out).toBe("connecting with [redacted] now");
  });
});
