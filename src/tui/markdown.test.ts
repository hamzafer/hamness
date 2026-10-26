import { expect, test } from "bun:test";
import { MARKDOWN_STYLES } from "./markdown.ts";

test("every heading level has the heading style, since OpenTUI falls back only to `markup`", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    expect(MARKDOWN_STYLES[`markup.heading.${level}` as keyof typeof MARKDOWN_STYLES]).toEqual(
      MARKDOWN_STYLES["markup.heading"],
    );
  }
});
