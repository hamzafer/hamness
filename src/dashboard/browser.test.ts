import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { seedDemoHistory } from "../../test/support/dashboard-seed.ts";
import { seeder } from "../../test/support/stats-seed.ts";
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
    "decision times stay on one line; paths in the session folder read relative",
    async () => {
      const page = await open("light");
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Decisions", exact: true })
        .click();
      await page.locator("main table tbody tr").first().waitFor();
      const times = await page.locator("main table tbody td.when").allTextContents();
      expect(times.length).toBeGreaterThan(0);
      for (const t of times) expect(t).toMatch(/^(\d{2}:\d{2}|[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})$/);
      // One line: each time cell's text lays out as a single line box.
      const tall = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("main td.when")].filter((td) => {
            const r = document.createRange();
            r.selectNodeContents(td);
            return new Set([...r.getClientRects()].map((b) => Math.round(b.top))).size !== 1;
          }).length,
      );
      expect(tall).toBe(0);
      const reasons = (await page.locator("main table tbody td.reason").allTextContents()).join(
        "\n",
      );
      expect(reasons).toContain('"*" for src/');
      expect(reasons).not.toContain("/work/acme/app/");
      const short = page.locator("main td.reason .reasonbtn").first();
      expect(await short.textContent()).not.toContain("/work/acme/app/");
      await short.click();
      expect(await short.textContent()).toContain("/work/acme/app/");
      expect(await short.getAttribute("aria-expanded")).toBe("true");
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the decisions view fits a phone: every row's verdict is on screen, no sideways scroll",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const page = await open(scheme, 390, 844);
        await page
          .getByRole("navigation")
          .getByRole("button", { name: "Decisions", exact: true })
          .click();
        await page.locator("main table tbody tr").first().waitFor();
        const off = await page.evaluate(() => {
          const wrap = document.querySelector<HTMLElement>("main .table-wrap");
          const pills = [...document.querySelectorAll("main tbody .pill")];
          return {
            page: document.documentElement.scrollWidth - window.innerWidth,
            wrap: wrap ? wrap.scrollWidth - wrap.clientWidth : -1,
            pills: pills.filter((p) => p.getBoundingClientRect().right > window.innerWidth).length,
            total: pills.length,
          };
        });
        expect(off.page).toBeLessThanOrEqual(0);
        expect(off.wrap).toBeLessThanOrEqual(0);
        expect(off.total).toBeGreaterThan(0);
        expect(off.pills).toBe(0);
        // The cards keep table semantics: display changes would drop the implicit roles.
        const roles = await page.evaluate(() => {
          const t = document.querySelector("main table.decisions");
          const role = (s: string) =>
            [...(t?.querySelectorAll(s) ?? [])].every((e) => e.getAttribute("role") !== null)
              ? [...new Set([...(t?.querySelectorAll(s) ?? [])].map((e) => e.getAttribute("role")))]
              : ["missing"];
          return {
            table: t?.getAttribute("role"),
            groups: role("thead, tbody"),
            rows: role("tr"),
            heads: role("th"),
            cells: role("td"),
            labels: t?.querySelectorAll("[data-label]").length,
          };
        });
        expect(roles).toEqual({
          table: "table",
          groups: ["rowgroup"],
          rows: ["row"],
          heads: ["columnheader"],
          cells: ["cell"],
          labels: 0,
        });
        expect(await page.getByRole("columnheader", { name: "Verdict" }).count()).toBe(1);
        await page.screenshot({ path: join(shots, `decisions-${scheme}-phone.png`) });
        await page.close();
      }
    },
    BROWSER_TIMEOUT,
  );

  test(
    "top models are ranked by cost, with labels outside the bars",
    async () => {
      const page = await open("dark");
      const models = page.locator(".card", {
        has: page.locator(".card-title", { hasText: /^Top models$/ }),
      });
      const values = await models.locator(".barlist-value").allTextContents();
      const costs = values.map((v) =>
        Number(/\$([\d,.]+)/.exec(v)?.[1]?.replaceAll(",", "") ?? -1),
      );
      expect(costs.length).toBeGreaterThan(1);
      expect(costs).toEqual([...costs].sort((a, b) => b - a));
      expect(values[0]).toMatch(/calls/);
      // No label or value overlaps its bar.
      const overlaps = await models.evaluate(
        (card) =>
          [...card.querySelectorAll("li")].filter((li) => {
            const bar = li.querySelector(".barlist-bar")?.getBoundingClientRect();
            if (!bar) return true;
            return [...li.querySelectorAll(".barlist-label, .barlist-value")].some((t) => {
              const r = t.getBoundingClientRect();
              return (
                r.bottom > bar.top && r.top < bar.bottom && r.right > bar.left && r.left < bar.right
              );
            });
          }).length,
      );
      expect(overlaps).toBe(0);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "the verified rate tile says what it divides by",
    async () => {
      const page = await open("light");
      const sub =
        (await page
          .locator(".tile", { has: page.locator(".tile-label", { hasText: /^Verified rate$/ }) })
          .locator(".tile-sub")
          .textContent()) ?? "";
      expect(sub).toMatch(/^of \d+ verified \+ unverified/);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "an open page refreshes quietly after a run ends, without a loading state",
    async () => {
      const page = await open("dark");
      const cost = tileValue(page, "Cost");
      const before = await cost.textContent();
      await page.evaluate(() => {
        const w = window as unknown as { flashed: boolean };
        w.flashed = false;
        new MutationObserver(() => {
          if (document.querySelector("#main[aria-busy], #main .loading")) w.flashed = true;
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      const sessionId = openTaskSession();
      seeder(d.db.sqlite).modelCall({
        sessionId,
        at: Date.now(),
        model: "claude-opus-5-5",
        input: 10,
        output: 10,
        costMicros: 7_000_000,
      });
      await startRun(page, sessionId);
      d.emit(event(sessionId, { type: "agent.status", busy: false }));
      await page.waitForFunction(
        (b) => document.querySelector(".tile-value")?.textContent !== b,
        before,
        { timeout: 10_000 },
      );
      expect(await page.evaluate(() => (window as unknown as { flashed: boolean }).flashed)).toBe(
        false,
      );
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "a clicked button does not stop live refresh: the view updates and keeps its focus",
    async () => {
      const page = await open("light");
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Decisions", exact: true })
        .click();
      await page.locator("main table tbody tr").first().waitFor();
      const btn = page.locator("main td.call .callbtn").first();
      await btn.click();
      await btn.click(); // open, then closed again: focus stays on it
      const key = await btn.getAttribute("data-key");
      expect(key).toBeTruthy();
      const before = await page.locator("main table tbody tr").count();
      const sessionId = openTaskSession();
      seeder(d.db.sqlite).decision({
        sessionId,
        at: Date.now(),
        tool: "bash",
        verdict: "allow",
        source: "rule",
        reason: "fresh decision for the refresh test",
        args: { command: "ls fresh" },
      });
      d.emit(event(sessionId, { type: "agent.tool.end", toolCallId: "fr1", status: "ok" }));
      await page.getByText("fresh decision for the refresh test").waitFor({ timeout: 10_000 });
      expect(await page.locator("main table tbody tr").count()).toBeGreaterThanOrEqual(before);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe(key);
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "a replaced chart stops observing its size",
    async () => {
      const page = await (browser as Browser).newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript(() => {
        const w = window as unknown as { liveObservers: number };
        w.liveObservers = 0;
        const Real = window.ResizeObserver;
        window.ResizeObserver = class extends Real {
          override observe(t: Element, o?: ResizeObserverOptions) {
            w.liveObservers++;
            super.observe(t, o);
          }
          override disconnect() {
            w.liveObservers--;
            super.disconnect();
          }
        };
      });
      await page.goto(link);
      await loaded(page);
      await page.locator(".chart svg").waitFor();
      for (const name of ["Tokens", "Tasks", "Cost"]) {
        await page
          .getByRole("group", { name: "Chart metric" })
          .getByRole("button", { name, exact: true })
          .click();
        await loaded(page);
        await page.locator(".chart svg").waitFor();
      }
      expect(
        await page.evaluate(() => (window as unknown as { liveObservers: number }).liveObservers),
      ).toBe(1);
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
      await page.getByRole("button", { name: "All", exact: true }).click();
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
    "the source starts on hamness when it has sessions, with All one click away and est. on imports",
    async () => {
      const page = await open("light");
      const picked = () =>
        page
          .locator(
            '[aria-label="Source"] [aria-pressed="true"], [aria-label="Source"] [aria-checked="true"]',
          )
          .textContent();
      expect(await picked()).toBe("hamness");
      expect(page.url()).not.toContain("source=");
      const bySource = () =>
        page
          .locator(".card", { has: page.locator(".card-title", { hasText: /^By source$/ }) })
          .locator(".barlist-value")
          .allTextContents();
      expect(await bySource()).toHaveLength(1);
      await page.getByRole("button", { name: "All", exact: true }).click();
      await loaded(page);
      expect(page.url()).toContain("source=all");
      expect(await picked()).toBe("All");
      const rows = await bySource();
      expect(rows.length).toBe(3);
      // Imported spend is labeled an estimate; hamness's own is not.
      expect(rows.some((t) => / est\. · /.test(t))).toBe(true);
      expect(rows[0]).not.toContain("est.");
      await page.close();
    },
    BROWSER_TIMEOUT,
  );

  test(
    "all calls on the plan: $0 (plan) everywhere, one $0 baseline, also at phone width",
    async () => {
      const planHome = tempHome();
      const pd = await startDaemon({ dataDir: planHome.dir, port: 0, contextFiles: false });
      try {
        const seed = seeder(pd.db.sqlite);
        const now = Date.now();
        const sid = seed.session({ source: "hamness", at: now - 3 * 3_600_000 });
        const tid = seed.task({ sessionId: sid, at: now - 2 * 3_600_000, outcome: "verified" });
        for (const at of [now - 2 * 3_600_000, now - 3_600_000])
          seed.modelCall({ sessionId: sid, taskId: tid, at, model: "plan-model", billing: "plan" });
        const token = readFileSync(dataPaths(planHome.dir).token, "utf8").trim();
        for (const [width, height] of [
          [1280, 900],
          [390, 844],
        ] as const) {
          const page = await (browser as Browser).newPage({ viewport: { width, height } });
          await page.goto(`${pd.url}/dash#token=${token}`);
          await loaded(page);
          await page.locator(".chart svg").waitFor();
          await page.waitForFunction(
            () => document.querySelectorAll(".chart .grid text").length > 0,
          );
          expect(await tileValue(page, "Cost").textContent()).toBe("$0 (plan)");
          expect(await tileValue(page, "Cost per verified task").textContent()).toBe("$0 (plan)");
          const ticks = await page.locator(".chart .grid text").allTextContents();
          expect(ticks).toEqual(["$0"]);
          expect(await page.getByText("All calls on your plan ($0).").count()).toBe(1);
          const bySource = await page
            .locator(".card", { has: page.locator(".card-title", { hasText: /^By source$/ }) })
            .locator(".barlist-value")
            .allTextContents();
          expect(bySource[0]).toStartWith("$0 (plan) · ");
          expect(await page.locator("body").textContent()).not.toContain("$0.00");
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          await page.screenshot({
            path: join(shots, `plan-only-overview-${width}.png`),
            fullPage: true,
          });
          await page.locator(".top nav").getByRole("button", { name: "Tasks" }).click();
          await loaded(page);
          expect(await page.locator("table.tasks tbody td.num").first().textContent()).toBe(
            "$0 (plan)",
          );
          await page.screenshot({
            path: join(shots, `plan-only-tasks-${width}.png`),
            fullPage: true,
          });
          await page.close();
        }
      } finally {
        await pd.stop();
        planHome.cleanup();
      }
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
