import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { seedDemoHistory } from "../../test/support/dashboard-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { type RunningDaemon, startDaemon } from "../daemon/daemon.ts";

/**
 * The dashboard in a real browser, on synthetic data. Uses Playwright's own Chromium if it is
 * installed, else the system Chrome; skips when neither is there. Screenshots (light and dark,
 * desktop and phone) go to `HAMNESS_SHOTS_DIR`, or a temp dir.
 */

async function launch(): Promise<Browser | null> {
  for (const opts of [{}, { channel: "chrome" }]) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch {
      // try the next one
    }
  }
  return null;
}

const browser = await launch();
const suite = browser ? describe : describe.skip;
const shots = process.env.HAMNESS_SHOTS_DIR ?? join(tmpdir(), "hamness-dashboard-shots");

let home: ReturnType<typeof tempHome>;
let d: RunningDaemon;
let link: string;

beforeAll(async () => {
  if (!browser) return;
  mkdirSync(shots, { recursive: true });
  home = tempHome();
  d = await startDaemon({ dataDir: home.dir, port: 0, contextFiles: false });
  seedDemoHistory(d.db.sqlite, Date.now());
  link = `${d.url}/dash#token=${readFileSync(dataPaths(home.dir).token, "utf8").trim()}`;
});
afterAll(async () => {
  await browser?.close();
  if (d) await d.stop();
  home?.cleanup();
});

async function open(scheme: "light" | "dark", width = 1280, height = 900): Promise<Page> {
  const page = await (browser as Browser).newPage({
    colorScheme: scheme,
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(link);
  await page.locator(".tile").first().waitFor();
  await page.locator(".chart svg").waitFor();
  expect(errors).toEqual([]);
  return page;
}

const tileValue = (page: Page, label: string) =>
  page
    .locator(".tile", { has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator(".tile-value");

suite("dashboard in a browser", () => {
  test("loads with the token, then wipes it from the address bar", async () => {
    const page = await open("dark");
    expect(page.url()).not.toContain("token");
    expect(page.url()).toEndWith("/dash");
    expect(await page.locator(".tile").count()).toBe(5);
    expect(await tileValue(page, "Cost").textContent()).toMatch(/\$\d/);
    // A reload keeps working: the token is in this tab's sessionStorage.
    await page.reload();
    await page.locator(".tile").first().waitFor();
    await page.close();
  });

  test("range and source toggles change the numbers", async () => {
    const page = await open("light");
    const cost = tileValue(page, "Cost");
    const week = await cost.textContent();
    await page.getByRole("button", { name: "24h", exact: true }).click();
    await page.waitForFunction(
      (w) => document.querySelector(".tile-value")?.textContent !== w,
      week,
    );
    const day = await cost.textContent();
    expect(day).not.toBe(week);
    expect(page.url()).toContain("range=24h");
    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    await page.waitForFunction(
      (t) => document.querySelector(".tile-value")?.textContent !== t,
      day,
    );
    expect(await tileValue(page, "Verified rate").textContent()).toBe("n/a");
    expect(await page.getByText("n/a for imported history").count()).toBeGreaterThan(0);
    await page.close();
  });

  test("the chart answers hover with a tooltip and has a table view", async () => {
    const page = await open("light");
    const box = await page.locator(".chart svg").boundingBox();
    if (!box) throw new Error("no chart");
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(page.locator(".chart-tip").isVisible()).resolves.toBe(true);
    expect(await page.locator(".chart-tip").textContent()).toContain("Cost: $");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.locator("main table").waitFor();
    expect(await page.locator("main table tbody tr").count()).toBe(7);
    await page.close();
  });

  test("the task table shows outcomes and opens evidence", async () => {
    const page = await open("light");
    await page.getByRole("navigation").getByRole("button", { name: "Tasks", exact: true }).click();
    await page.locator("table.tasks").waitFor();
    expect(await page.locator("table.tasks tbody tr:not(.detail)").count()).toBeGreaterThan(3);
    await page.getByRole("button", { name: "verified", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("table.tasks tbody tr:not(.detail) .pill")].every(
        (p) => p.textContent === "verified",
      ),
    );
    await page.locator(".rowbtn").first().click();
    await page.locator("tr.detail:not([hidden]) .evidence li").first().waitFor();
    expect(await page.locator("tr.detail:not([hidden])").textContent()).toContain(
      "bun test exited 0",
    );
    await page.screenshot({ path: join(shots, "tasks-light.png"), fullPage: true });
    await page.close();
  });

  test("the decisions view lists verdicts with reasons", async () => {
    const page = await open("dark");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Decisions", exact: true })
      .click();
    await page.locator("main table tbody tr").first().waitFor();
    const text = (await page.locator("main table").textContent()) ?? "";
    expect(text).toMatch(/allow|ask|deny/);
    expect(text).toContain("read-only command in the project");
    await page.screenshot({ path: join(shots, "decisions-dark.png"), fullPage: true });
    await page.close();
  });

  test("screenshots in light and dark; no sideways scroll at phone width", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const page = await open(scheme);
      await page.screenshot({ path: join(shots, `overview-${scheme}.png`), fullPage: true });
      await page.close();
      const phone = await open(scheme, 390, 844);
      const overflow = await phone.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await phone.screenshot({ path: join(shots, `overview-${scheme}-phone.png`), fullPage: true });
      await phone.close();
    }
  });

  test("the theme toggle overrides the system setting", async () => {
    const page = await open("light");
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    await page.getByRole("button", { name: /Theme: system/ }).click(); // -> light
    await page.getByRole("button", { name: /Theme: light/ }).click(); // -> dark
    expect(await bg()).not.toBe(light);
    await page.close();
  });

  test("without a token the page says how to open it", async () => {
    const page = await (browser as Browser).newPage();
    await page.goto(`${d.url}/dash`);
    await page.getByText("hamness dashboard").first().waitFor();
    expect(await page.locator(".signed-out").count()).toBe(1);
    await page.close();
  });
});
