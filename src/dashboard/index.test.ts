import { describe, expect, test } from "bun:test";
import { clientScript } from "./index.ts";

describe("dashboard bundle", () => {
  test("keeps the vendored orbs' MIT notice through minification", async () => {
    const { body } = await clientScript();
    expect(body).toContain("thinking-orbs (c) 2026 Jakub Antalik, MIT");
  });
});
