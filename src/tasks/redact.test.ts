import { describe, expect, test } from "bun:test";
import { redactText } from "./redact.ts";

describe("redactText", () => {
  test("masks secret assignments, bearer tokens and well-known key shapes", () => {
    const out = redactText(
      [
        "API_KEY=abc123def456",
        'password: "hunter2hunter2"',
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
        "gh token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "aws AKIAABCDEFGHIJKLMNOP",
        "all 12 tests passed",
      ].join("\n"),
    );
    for (const secret of [
      "abc123def456",
      "hunter2hunter2",
      "eyJhbGciOiJIUzI1NiJ9",
      "sk-ant-api03",
      "ghp_ABCDEF",
      "AKIAABCDEFGHIJKLMNOP",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("all 12 tests passed");
    expect(out).toContain("[redacted]");
  });

  test("masks the values of secret-looking environment variables wherever they appear", () => {
    const out = redactText("connecting with zq9-synthetic-value-77 now", {
      MY_SERVICE_TOKEN: "zq9-synthetic-value-77",
      HOME_DIR: "/not/secret",
    });
    expect(out).toBe("connecting with [redacted] now");
  });
});
