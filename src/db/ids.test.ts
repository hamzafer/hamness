import { expect, test } from "bun:test";
import { newId } from "./ids.ts";

test("ids are unique and sort in creation order", () => {
  const ids = Array.from({ length: 50 }, () => newId());
  expect(new Set(ids).size).toBe(50);
  expect([...ids].sort()).toEqual(ids);
});
