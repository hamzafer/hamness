import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { seedDemoHistory } from "../../test/support/dashboard-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { type RunningDaemon, startDaemon } from "../daemon/daemon.ts";
import type { HamnessEvent } from "../events/types.ts";

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
/** A cold Chromium on a shared CI runner can take seconds for its first page. */
const BROWSER_TIMEOUT = 30_000;
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

async function open(
  scheme: "light" | "dark",
  width = 1280,
  height = 900,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const page = await (browser as Browser).newPage({
    colorScheme: scheme,
    viewport: { width, height },
    deviceScaleFactor: 2,
    reducedMotion,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(link);
  await loaded(page);
  await page.locator(".tile").first().waitFor();
  await page.locator(".chart svg").waitFor();
  expect(errors).toEqual([]);
  return page;
}

/** The page's own readiness signal: `#main` drops `aria-busy` once its data is in. */
async function loaded(page: Page): Promise<void> {
  await page.locator("#main:not([aria-busy])").waitFor({ timeout: BROWSER_TIMEOUT });
}

let seq = 0;
const event = (sessionId: string, e: Record<string, unknown>) =>
  ({ sessionId, seq: ++seq, args: {}, ...e }) as unknown as HamnessEvent;

/** The seeded task still open today, and its session. */
const openTaskSession = () =>
  (
    d.db.sqlite.query("SELECT session_id FROM tasks WHERE outcome = 'open' LIMIT 1").get() as {
      session_id: string;
    }
  ).session_id;

/** Marks the session busy until the page's event stream has picked it up. */
async function startRun(page: Page, sessionId: string): Promise<void> {
  const header = page.locator(".top .live");
  for (let i = 0; i < 50 && !(await header.isVisible()); i++) {
    d.emit(event(sessionId, { type: "agent.status", busy: true }));
    await page.waitForTimeout(100);
  }
  await header.waitFor();
}

const pixels = (page: Page, selector: string) =>
  page.evaluate((s) => document.querySelector<HTMLCanvasElement>(s)?.toDataURL() ?? "", selector);

const tileValue = (page: Page, label: string) =>
  page
    .locator(".tile", { has: page.locator(".tile-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator(".tile-value");

suite("dashboard in a browser", () => {
  test(
    "loads with the token, then wipes it from the address bar",
    async () => {
      const page = await open("dark");
      expect(page.url()).not.toContain("token");
      expect(page.url()).toEndWith("/dash");
      expect(await page.locator(".tile").count()).toBe(5);
      expect(await tileValue(page, "Cost").textContent()).toMatch(/\$\d/);
      // A reload keeps working: the token is in this tab's sessionStorage.
      await page.reload();
      await loaded(page);
      await page.locator(".tile").first().waitFor();
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "range and source toggles change the numbers",
    async () => {
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
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the chart answers hover with a tooltip and has a table view",
    async () => {
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
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the task table shows outcomes and opens evidence",
    async () => {
      const page = await open("light");
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Tasks", exact: true })
        .click();
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
      const detail = (await page.locator("tr.detail:not([hidden])").textContent()) ?? "";
      expect(detail).toContain("bun test exited 0");
      // P-L4: the task's branch, commit and PR.
      expect(detail).toContain("Branch: feature/task-");
      expect(detail).toContain("Commit: ");
      const pr = page.locator("tr.detail:not([hidden]) a.pr");
      expect(await pr.getAttribute("href")).toStartWith("https://github.com/acme/app/pull/");
      await page.screenshot({ path: join(shots, "tasks-light.png"), fullPage: true });
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the decisions view lists verdicts with reasons",
    async () => {
      const page = await open("dark");
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Decisions", exact: true })
        .click();
      await page.locator("main table tbody tr").first().waitFor();
      const text = (await page.locator("main table").textContent()) ?? "";
      expect(text).toMatch(/allow|ask|deny/);
      expect(text).toContain("read-only command in the project");
      // The call, short as `hamness audit` prints it, with the full text in its title.
      const call = page.locator("main table tbody td.call code").first();
      expect((await call.textContent())?.length).toBeGreaterThan(0);
      const long = page
        .locator("main table tbody td.call code", { hasText: "rm -rf dist" })
        .first();
      expect(await long.textContent()).toEndWith("…");
      expect(await long.getAttribute("title")).toContain("--target=bun");
      await long.click();
      expect(await long.textContent()).toEndWith("--target=bun");
      await page.screenshot({ path: join(shots, "decisions-dark.png"), fullPage: true });
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the active time tile counts sessions the same way By source does",
    async () => {
      const page = await open("light");
      await page.getByRole("button", { name: "30d", exact: true }).click();
      await loaded(page);
      await page.locator(".tile").first().waitFor();
      const sub =
        (await page
          .locator(".tile", { has: page.locator(".tile-label", { hasText: /^Active time$/ }) })
          .locator(".tile-sub")
          .textContent()) ?? "";
      const bySource = await page
        .locator(".card", { has: page.locator(".card-title", { hasText: /^By source$/ }) })
        .locator(".barlist-value")
        .allTextContents();
      const total = bySource.reduce((n, t) => n + Number(/(\d+) sessions/.exec(t)?.[1] ?? 0), 0);
      // The seed has Codex sessions without active time: the tile says how many have it.
      expect(sub).toMatch(new RegExp(`^\\d+ of ${total} sessions with time recorded;`));
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "switching views shows a quiet loading state for the new view, never the old one's rows",
    async () => {
      const page = await open("dark");
      const nav = page.getByRole("navigation");
      await nav.getByRole("button", { name: "Tasks", exact: true }).click();
      await page.locator("table.tasks").waitFor();
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      await page.route("**/v1/decisions**", async (route) => {
        await held;
        await route.continue();
      });
      await nav.getByRole("button", { name: "Decisions", exact: true }).click();
      const main = page.locator("#main");
      expect(await main.getAttribute("aria-busy")).toBe("true");
      expect(await page.locator("table.tasks").count()).toBe(0);
      expect(await main.locator(".card-title").textContent()).toBe("Safety decisions");
      expect(await main.locator(".loading").textContent()).toContain("Loading");
      // The header and range controls stay put while the view loads.
      expect(await page.locator(".controls").count()).toBe(1);
      release();
      await loaded(page);
      await page.locator("main table tbody td.call").first().waitFor();
      expect(await main.locator(".loading").count()).toBe(0);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "an older view finishing late keeps the newer view marked as loading",
    async () => {
      const page = await open("light");
      await page.locator("main .card").first().waitFor();
      const nav = page.getByRole("navigation");
      const hold = async (pattern: string) => {
        let release = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        await page.route(pattern, async (route) => {
          await held;
          await route.continue();
        });
        return () => release();
      };
      const releaseTasks = await hold("**/v1/tasks**");
      const releaseDecisions = await hold("**/v1/decisions**");
      await nav.getByRole("button", { name: "Tasks", exact: true }).click();
      await nav.getByRole("button", { name: "Decisions", exact: true }).click();
      const main = page.locator("#main");
      releaseTasks();
      await page.waitForTimeout(200);
      expect(await main.getAttribute("aria-busy")).toBe("true");
      releaseDecisions();
      await page.locator("main table tbody td.call").first().waitFor();
      expect(await main.getAttribute("aria-busy")).toBeNull();
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "screenshots in light and dark; no sideways scroll at phone width",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const page = await open(scheme);
        await page.screenshot({ path: join(shots, `overview-${scheme}.png`), fullPage: true });
        await page.close();
        const phone = await open(scheme, 390, 844);
        const overflow = await phone.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // Every y-axis label sits inside the chart's card, none cut at its left edge.
        const cut = await phone.evaluate(() => {
          const card = document.querySelector(".hero")?.getBoundingClientRect();
          return [...document.querySelectorAll(".chart .grid text")].filter(
            (t) => card && t.getBoundingClientRect().left < card.left,
          ).length;
        });
        expect(cut).toBe(0);
        await phone.screenshot({
          path: join(shots, `overview-${scheme}-phone.png`),
          fullPage: true,
        });
        await phone.close();
      }
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the theme toggle overrides the system setting",
    async () => {
      const page = await open("light");
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const light = await bg();
      await page.getByRole("button", { name: /Theme: system/ }).click(); // -> light
      await page.getByRole("button", { name: /Theme: light/ }).click(); // -> dark
      expect(await bg()).not.toBe(light);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "a live run shows its orb in the header and on its task, and stops when the run ends",
    async () => {
      const sessionId = openTaskSession();
      for (const scheme of ["light", "dark"] as const) {
        const page = await open(scheme);
        const header = page.locator(".top .live");
        await startRun(page, sessionId);
        d.emit(event(sessionId, { type: "agent.tool.start", toolCallId: "t1", tool: "grep" }));
        await header.getByText("Searching the code").waitFor();
        const canvas = header.locator("canvas.orb");
        expect(await canvas.getAttribute("data-orb-state")).toBe("searching");
        // 20 CSS px at device pixel ratio 2.
        expect(await canvas.getAttribute("width")).toBe("40");
        // It moves: two frames apart differ.
        const a = await pixels(page, ".top .live canvas");
        await page.waitForTimeout(150);
        expect(await pixels(page, ".top .live canvas")).not.toBe(a);

        await page
          .getByRole("navigation")
          .getByRole("button", { name: "Tasks", exact: true })
          .click();
        const note = page.locator(`.live-note[data-session="${sessionId}"]`);
        await note.getByText("Searching the code").waitFor();
        d.emit(event(sessionId, { type: "agent.tool.end", toolCallId: "t1", status: "ok" }));
        d.emit(event(sessionId, { type: "agent.tool.start", toolCallId: "t2", tool: "edit" }));
        await note.getByText("Editing files").waitFor();
        await page.screenshot({ path: join(shots, `orb-tasks-${scheme}.png`) });

        d.emit(event(sessionId, { type: "agent.status", busy: false }));
        await header.waitFor({ state: "hidden" });
        await note.waitFor({ state: "hidden" });
        await page.close();
      }
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the header's status region says only coarse changes, never each tool",
    async () => {
      const sessionId = openTaskSession();
      const page = await open("light");
      const status = page.locator(".top [role=status]");
      expect(await status.count()).toBe(1);
      await startRun(page, sessionId);
      d.emit(event(sessionId, { type: "agent.tool.start", toolCallId: "s1", tool: "grep" }));
      await page.locator(".top .live").getByText("Searching the code").waitFor();
      expect(await status.textContent()).toBe("Agent working");
      // The visible words sit outside the live region.
      expect(await page.locator(".top .live span").getAttribute("aria-live")).toBe("off");
      d.emit(event(sessionId, { type: "agent.tool.end", toolCallId: "s1", status: "ok" }));
      d.emit(event(sessionId, { type: "agent.tool.start", toolCallId: "s2", tool: "edit" }));
      await page.locator(".top .live").getByText("Editing files").waitFor();
      expect(await status.textContent()).toBe("Agent working");
      d.emit(
        event(sessionId, {
          type: "safety.approval.request",
          approval: { id: "ap-s", toolCallId: "s3", tool: "bash", args: {} },
        }),
      );
      await page.waitForFunction(
        () => document.querySelector(".top [role=status]")?.textContent === "Waiting for you",
      );
      d.emit(
        event(sessionId, {
          type: "safety.approval.resolved",
          approvalId: "ap-s",
          decision: "deny",
          by: "user",
        }),
      );
      d.emit(event(sessionId, { type: "agent.status", busy: false }));
      await page.waitForFunction(
        () => document.querySelector(".top [role=status]")?.textContent === "Agents idle",
      );
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "reduced motion draws one still orb that follows the theme toggle",
    async () => {
      const sessionId = openTaskSession();
      const page = await open("light", 1280, 900, "reduce");
      await startRun(page, sessionId);
      const still = await pixels(page, ".top .live canvas");
      await page.waitForTimeout(200);
      expect(await pixels(page, ".top .live canvas")).toBe(still);
      await page.getByRole("button", { name: /Theme: system/ }).click(); // -> light
      await page.getByRole("button", { name: /Theme: light/ }).click(); // -> dark
      await page.waitForFunction((before) => {
        const c = document.querySelector<HTMLCanvasElement>(".top .live canvas");
        return c !== null && c.toDataURL() !== before;
      }, still);
      d.emit(event(sessionId, { type: "agent.status", busy: false }));
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "without a token the page says how to open it",
    async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${d.url}/dash`);
      await page.getByText("hamness dashboard").first().waitFor();
      expect(await page.locator(".signed-out").count()).toBe(1);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );
});
