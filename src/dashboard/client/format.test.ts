import { describe, expect, test } from "bun:test";
import { relativeToCwd, shortWhen } from "./format.ts";

describe("shortWhen", () => {
  const now = new Date(2026, 9, 25, 18, 0).getTime();
  test("today is just the time", () => {
    expect(shortWhen(new Date(2026, 9, 25, 17, 16).getTime(), now)).toBe("17:16");
    expect(shortWhen(new Date(2026, 9, 25, 0, 5).getTime(), now)).toBe("00:05");
  });
  test("another day this year is the day and time, no comma", () => {
    expect(shortWhen(new Date(2026, 9, 24, 9, 3).getTime(), now)).toBe("Oct 24 09:03");
  });
  test("another year says the year", () => {
    expect(shortWhen(new Date(2025, 11, 30, 23, 59).getTime(), now)).toBe("Dec 30 2025 23:59");
  });
});

describe("relativeToCwd", () => {
  const cwd = "/work/acme/app";
  test("paths inside the session folder become relative", () => {
    expect(
      relativeToCwd(`allowed by default rule {read} "*" for /work/acme/app/src/a.ts`, cwd),
    ).toBe(`allowed by default rule {read} "*" for src/a.ts`);
    expect(relativeToCwd(`"$CWD/**" for /work/acme/app/x and /work/acme/app/y/z`, cwd)).toBe(
      `"$CWD/**" for x and y/z`,
    );
  });
  test("the folder itself becomes a dot", () => {
    expect(relativeToCwd("writes in /work/acme/app", cwd)).toBe("writes in .");
    expect(relativeToCwd("cd /work/acme/app/ then", cwd)).toBe("cd ./ then");
  });
  test("a sibling folder with the same prefix is left alone", () => {
    expect(relativeToCwd("reads /work/acme/app2/secret", cwd)).toBe("reads /work/acme/app2/secret");
  });
  test("a trailing slash on the cwd changes nothing", () => {
    expect(relativeToCwd("for /work/acme/app/a.ts", `${cwd}/`)).toBe("for a.ts");
  });
  test("no cwd, a relative cwd (imported) or the root leaves the text as it is", () => {
    const t = "for /work/acme/app/a.ts";
    expect(relativeToCwd(t, null)).toBe(t);
    expect(relativeToCwd(t, "app")).toBe(t);
    expect(relativeToCwd(t, "/")).toBe(t);
  });
});
