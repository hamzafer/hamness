import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DAY, HOUR, seeder } from "../../test/support/stats-seed.ts";
import { tempHome } from "../../test/support/temp-home.ts";
import { dataPaths } from "../config/paths.ts";
import { type RunningDaemon, startDaemon } from "../daemon/daemon.ts";
import type {
  DecisionListRow,
  EvidenceRow,
  Page,
  StatsReport,
  TaskListRow,
} from "../stats/index.ts";

let home: ReturnType<typeof tempHome>;
let d: RunningDaemon;
let ids: { verified: string; unverified: string; old: string; cc: string };

beforeEach(async () => {
  home = tempHome();
  d = await startDaemon({ dataDir: home.dir, port: 0, contextFiles: false });
  const now = Date.now();
  const seed = seeder(d.db.sqlite);
  const h = seed.session({ source: "hamness", at: now - 2 * HOUR });
  const verified = seed.task({
    sessionId: h,
    at: now - 2 * HOUR,
    endAt: now - HOUR,
    outcome: "verified",
    goal: "add the parser",
  });
  seed.evidence({ taskId: verified, at: now - HOUR, status: "passed", summary: "exit 0" });
  seed.modelCall({
    sessionId: h,
    taskId: verified,
    at: now - 2 * HOUR,
    model: "m",
    costMicros: 2_000_000,
  });
  const unverified = seed.task({ sessionId: h, at: now - 3 * HOUR, outcome: "unverified" });
  const old = seed.task({ sessionId: h, at: now - 5 * DAY, outcome: "verified" });
  seed.modelCall({ sessionId: h, at: now - 5 * DAY, model: "m", costMicros: 1_000_000 });
  const c = seed.session({ source: "claude-code", at: now - 3 * DAY });
  const cc = seed.task({ sessionId: c, at: now - 3 * DAY, outcome: "abandoned" });
  seed.modelCall({ sessionId: c, at: now - 3 * DAY, model: "m", costMicros: 500_000 });
  seed.decision({ sessionId: h, at: now - HOUR, verdict: "deny", source: "rule", reason: "no" });
  seed.decision({ sessionId: c, at: now - 3 * DAY, verdict: "allow", source: "hook" });
  ids = { verified, unverified, old, cc };
});
afterEach(async () => {
  await d.stop();
  home.cleanup();
});

const token = () => readFileSync(dataPaths(home.dir).token, "utf8").trim();
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${d.url}${path}`, { headers: { authorization: `Bearer ${token()}`, ...headers } });
const getJson = async <T>(path: string): Promise<T> => {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

describe("GET /v1/stats", () => {
  test("range and source change the numbers", async () => {
    const day = await getJson<StatsReport>("/v1/stats?range=24h&tz=0");
    expect(day.range).toBe("24h");
    expect(day.kpis.costMicros).toBe(2_000_000);
    expect(day.kpis.tasks.total).toBe(2);
    expect(day.series.buckets).toHaveLength(24);

    const week = await getJson<StatsReport>("/v1/stats?range=7d&tz=0");
    expect(week.kpis.costMicros).toBe(3_500_000);
    expect(week.kpis.tasks.total).toBe(4);
    expect(week.series.buckets).toHaveLength(7);

    const hamness = await getJson<StatsReport>("/v1/stats?range=7d&source=hamness&tz=0");
    expect(hamness.source).toBe("hamness");
    expect(hamness.kpis.costMicros).toBe(3_000_000);
    expect(hamness.kpis.tasks.total).toBe(3);

    const all = await getJson<StatsReport>("/v1/stats?range=7d&source=all&tz=0");
    expect(all.source).toBeNull();
  });

  test("defaults to 7 days", async () => {
    expect((await getJson<StatsReport>("/v1/stats")).range).toBe("7d");
  });

  test("bad parameters are 400", async () => {
    for (const q of ["range=1y", "source=cursor", "tz=abc", "tz=99999"]) {
      const res = await get(`/v1/stats?${q}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeString();
    }
  });
});

describe("GET /v1/tasks", () => {
  test("lists tasks with filters and pages", async () => {
    const all = await getJson<Page<TaskListRow>>("/v1/tasks?range=7d");
    expect(all.rows.map((r) => r.id)).toEqual([ids.verified, ids.unverified, ids.cc, ids.old]);
    expect(all.rows[0]).toMatchObject({
      goal: "add the parser",
      costMicros: 2_000_000,
      durationMs: HOUR,
      evidence: { checked: 1, passed: 1, pending: 0 },
    });

    const verified = await getJson<Page<TaskListRow>>("/v1/tasks?range=7d&outcome=verified");
    expect(verified.rows.map((r) => r.id)).toEqual([ids.verified, ids.old]);
    const cc = await getJson<Page<TaskListRow>>("/v1/tasks?range=7d&source=claude-code");
    expect(cc.rows.map((r) => r.id)).toEqual([ids.cc]);

    const first = await getJson<Page<TaskListRow>>("/v1/tasks?range=7d&limit=3");
    expect(first.rows).toHaveLength(3);
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const rest = await getJson<Page<TaskListRow>>(`/v1/tasks?range=7d&limit=3&cursor=${cursor}`);
    expect(rest.rows.map((r) => r.id)).toEqual([ids.old]);
    expect(rest.nextCursor).toBeNull();
  });

  test("bad parameters are 400", async () => {
    for (const q of ["outcome=done", "limit=zero", "cursor=nope", "turns=maybe"]) {
      expect((await get(`/v1/tasks?${q}`)).status).toBe(400);
    }
  });

  test("a task's evidence summaries", async () => {
    const body = await getJson<{ evidence: EvidenceRow[] }>(`/v1/tasks/${ids.verified}/evidence`);
    expect(body.evidence).toHaveLength(1);
    expect(body.evidence[0]).toMatchObject({
      kind: "command",
      status: "passed",
      summary: "exit 0",
    });
    expect((await get("/v1/tasks/nope/evidence")).status).toBe(404);
  });
});

describe("GET /v1/decisions", () => {
  test("lists decisions with filters", async () => {
    const week = await getJson<Page<DecisionListRow>>("/v1/decisions?range=7d");
    expect(week.rows.map((r) => [r.verdict, r.decidedBy, r.sessionSource])).toEqual([
      ["deny", "rule", "hamness"],
      ["allow", "hook", "claude-code"],
    ]);
    const day = await getJson<Page<DecisionListRow>>("/v1/decisions?range=24h");
    expect(day.rows).toHaveLength(1);
    const allow = await getJson<Page<DecisionListRow>>("/v1/decisions?range=7d&verdict=allow");
    expect(allow.rows.map((r) => r.decidedBy)).toEqual(["hook"]);
    const hook = await getJson<Page<DecisionListRow>>("/v1/decisions?range=7d&decidedBy=rule");
    expect(hook.rows.map((r) => r.verdict)).toEqual(["deny"]);
  });

  test("bad parameters are 400", async () => {
    for (const q of ["verdict=maybe", "decidedBy=ghost"]) {
      expect((await get(`/v1/decisions?${q}`)).status).toBe(400);
    }
  });
});

describe("auth", () => {
  test("the data endpoints need the token", async () => {
    for (const path of [
      "/v1/stats",
      "/v1/tasks",
      "/v1/decisions",
      `/v1/tasks/${ids.old}/evidence`,
    ]) {
      expect((await fetch(`${d.url}${path}`)).status).toBe(401);
    }
  });

  test("a token in the query string is not accepted", async () => {
    const res = await fetch(`${d.url}/v1/stats?token=${token()}`);
    expect(res.status).toBe(401);
  });
});

describe("the dashboard page", () => {
  test("is served without a token, carries no data and locks itself down", async () => {
    const res = await fetch(`${d.url}/dash`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<script type="module" src="/dash/app.js"></script>');
    expect(html).not.toContain(token());
    expect(html).not.toContain("add the parser");
  });

  test("serves its script and styles", async () => {
    const js = await fetch(`${d.url}/dash/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await js.text()).length).toBeGreaterThan(1000);
    const css = await fetch(`${d.url}/dash/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toStartWith("text/css");
  });

  test("still checks the Host header", async () => {
    const res = await fetch(`${d.url}/dash`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("other paths under /dash need the token", async () => {
    expect((await fetch(`${d.url}/dash/secret.json`)).status).toBe(401);
  });
});
