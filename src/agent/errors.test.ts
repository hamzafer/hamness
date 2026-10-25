import { describe, expect, test } from "bun:test";
import { explainModelError } from "./errors.ts";

const DATA = "/data";

describe("explainModelError: model errors say what to do", () => {
  test("no API key names the env var and the key command", () => {
    const m = explainModelError("No API key found for anthropic", DATA);
    expect(m).toContain("ANTHROPIC_API_KEY");
    expect(m).toContain("hamness keys set anthropic");
    expect(m).toContain("hamness stop");
  });

  test("a ChatGPT login without the account claim says to sign in again", () => {
    const m = explainModelError("Failed to extract accountId from token", DATA, "openai-codex");
    expect(m).toContain("Sign in again: hamness login openai");
  });

  test("a refused key says to set a new one", () => {
    const m = explainModelError(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      DATA,
      "anthropic",
    );
    expect(m).toMatch(/^The anthropic API key was refused/);
    expect(m).toContain("hamness keys set anthropic");
  });

  test.each([
    ["Connection error."],
    ["fetch failed"],
    ["getaddrinfo ENOTFOUND api.anthropic.com"],
    ["connect ECONNREFUSED 127.0.0.1:443"],
    ["Request timed out."],
  ])("a network failure (%s) says to check the connection", (raw) => {
    const m = explainModelError(raw, DATA, "anthropic");
    expect(m).toMatch(/^Could not reach anthropic/);
    expect(m).toContain(raw);
    expect(m).toContain("send the prompt again");
  });

  test("anything else is passed through as it is", () => {
    expect(explainModelError("overloaded_error: Overloaded", DATA)).toBe(
      "overloaded_error: Overloaded",
    );
  });
});
