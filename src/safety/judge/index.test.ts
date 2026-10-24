import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tempHome } from "../../../test/support/temp-home.ts";
import { saveKey } from "../../agent/keys.ts";
import { judgeFromKeys } from "./index.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

describe("the judge's key", () => {
  test("no key in the env or the key file: no judge", () => {
    expect(judgeFromKeys({ dataDir: home.dir, env: {} })).toBeUndefined();
    // A subscription token is not an API key.
    expect(
      judgeFromKeys({ dataDir: home.dir, env: { ANTHROPIC_OAUTH_TOKEN: "t" } }),
    ).toBeUndefined();
  });

  test("ANTHROPIC_API_KEY or the key file's anthropic entry: a judge", () => {
    expect(judgeFromKeys({ dataDir: home.dir, env: { ANTHROPIC_API_KEY: "k" } })).toBeFunction();
    saveKey(home.dir, "anthropic", "k");
    expect(judgeFromKeys({ dataDir: home.dir, env: {} })).toBeFunction();
  });
});
