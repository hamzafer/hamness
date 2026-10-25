import { describe, expect, test } from "bun:test";
import { redactArgs, redactSecrets, redactText } from "./redact.ts";

// Synthetic, obviously fake secrets built at run time so no scanner mistakes them for real ones.
const fake = (prefix: string, n = 32) => `${prefix}${"a1B2".repeat(Math.ceil(n / 4)).slice(0, n)}`;

describe("redactArgs", () => {
  test("values under secret-looking keys are replaced", () => {
    expect(
      redactArgs({ api_key: "x", nested: { password: "p", ok: 1 }, list: [{ token: "t" }] }),
    ).toEqual({
      api_key: "[redacted]",
      nested: { password: "[redacted]", ok: 1 },
      list: [{ token: "[redacted]" }],
    });
  });

  test("secret-looking values are replaced wherever they appear", () => {
    const anthropic = fake("sk-ant-api03-", 40);
    const out = redactArgs({ command: `curl -H "x-api-key: ${anthropic}" https://example.test` });
    expect(JSON.stringify(out)).not.toContain(anthropic);
    expect(out.command).toContain("curl -H");
    expect(out.command).toContain("https://example.test");
  });

  test("the arguments object itself is not changed", () => {
    const args = { password: "p" };
    redactArgs(args);
    expect(args.password).toBe("p");
  });
});

describe("redactText", () => {
  test.each([
    ["an OpenAI-style key", fake("sk-proj-", 40)],
    ["an Anthropic key", fake("sk-ant-api03-", 40)],
    ["a GitHub token", fake("ghp_", 36)],
    ["a fine-grained GitHub token", fake("github_pat_", 50)],
    ["a Slack token", fake("xoxb-", 30)],
    ["an AWS access key id", `AKIA${"ABCD".repeat(4)}`],
    ["a Google API key", fake("AIza", 35)],
    ["a JWT", `eyJ${fake("", 20)}.eyJ${fake("", 20)}.${fake("", 20)}`],
  ])("%s", (_name, secret) => {
    const out = redactText(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("bearer and basic auth headers keep the scheme, lose the credential", () => {
    expect(redactText("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactText("-H 'authorization: basic dXNlcjpwYXNz'")).toBe(
      "-H 'authorization: basic [redacted]'",
    );
  });

  test("private key blocks", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjE=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(redactText(`key:\n${pem}\ndone`)).toBe("key:\n[redacted private key]\ndone");
  });

  test("passwords in URLs", () => {
    expect(redactText("git clone https://user:hunter2@example.test/r.git")).toBe(
      "git clone https://user:[redacted]@example.test/r.git",
    );
  });

  test("secret-named assignments and flags, as in .env files and commands", () => {
    expect(redactText("API_KEY=abc123\nDEBUG=1\nexport DB_PASSWORD='p w'")).toBe(
      "API_KEY=[redacted]\nDEBUG=1\nexport DB_PASSWORD=[redacted]",
    );
    expect(redactText("tool --token abc --password=xyz --verbose")).toBe(
      "tool --token [redacted] --password=[redacted] --verbose",
    );
    expect(redactText('{"client_secret": "s3cr3t", "name": "x"}')).toBe(
      '{"client_secret": "[redacted]", "name": "x"}',
    );
  });

  test("a value stops at backticks, quotes, parens and brackets", () => {
    expect(redactText("set `API_KEY=abc123` first")).toBe("set `API_KEY=[redacted]` first");
    expect(redactText("(TOKEN=abc) and [SECRET=xyz]")).toBe(
      "(TOKEN=[redacted]) and [SECRET=[redacted]]",
    );
    expect(redactText("run `tool --token abc`.")).toBe("run `tool --token [redacted]`.");
  });

  test("auth is a whole word: author and authority are not secrets", () => {
    const text = "GIT_AUTHOR_NAME=jane AUTHORITY=ca --author=me";
    expect(redactText(text)).toBe(text);
    expect(redactText("AUTH=abc --auth xyz")).toBe("AUTH=[redacted] --auth [redacted]");
  });

  test("redactSecrets (assistant replies): only unmistakable secrets, a marker Markdown keeps", () => {
    const key = fake("sk-ant-api03-", 40);
    expect(redactSecrets(`Use ${key} here.`)).toBe("Use ‹redacted› here.");
    expect(redactSecrets("git clone https://user:hunter2@example.test/r.git")).toBe(
      "git clone https://user:‹redacted›@example.test/r.git",
    );
    // Markdown and code that only name secrets are left alone.
    const reply = [
      "Set `API_KEY=your-key` in **.env**, then run `tool --token $TOKEN`.",
      "",
      "```bash",
      'export DB_PASSWORD="$(cat secret.txt)"',
      "curl -H 'Authorization: Bearer $TOKEN' https://api.example.test",
      "```",
      "See [the docs](https://docs.example.test/auth) by the author.",
    ].join("\n");
    expect(redactSecrets(reply)).toBe(reply);
  });

  test("ordinary text is left alone", () => {
    const text = "git commit -m 'tokenize input' && echo $PATH && ls sk-files/";
    expect(redactText(text)).toBe(text);
  });
});
