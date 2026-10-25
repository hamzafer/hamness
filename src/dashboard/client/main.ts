import { count, duration, money } from "../../stats/format.ts";
import type {
  DecisionListRow,
  EvidenceRow,
  Page,
  Range,
  Source,
  StatsReport,
  TaskListRow,
} from "../../stats/index.ts";
import type { TaskOutcome } from "../../tasks/types.ts";
import { getJson, takeToken, Unauthorized } from "./api.ts";
import { areaChart } from "./chart.ts";
import { h } from "./dom.ts";

// ---- State (kept in the query string so a reload keeps the view) ----

type View = "overview" | "tasks" | "decisions";
type Metric = "cost" | "tokens" | "tasks";

interface State {
  view: View;
  range: Range;
  source: Source | "all";
  metric: Metric;
  chartAs: "chart" | "table";
  outcome: TaskOutcome | "all";
  turns: boolean;
  verdict: "all" | "allow" | "ask" | "deny";
}

const RANGES: Range[] = ["today", "24h", "7d", "30d", "90d"];
const SOURCE_LABEL: Record<Source, string> = {
  hamness: "hamness",
  "claude-code": "Claude Code",
  codex: "Codex",
};
const RANGE_LABEL: Record<Range, string> = {
  today: "today",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};
const inRange = (r: Range) => (r === "today" ? "today" : `in the ${RANGE_LABEL[r]}`);
const OUTCOMES: TaskOutcome[] = ["verified", "unverified", "overridden", "abandoned", "open"];

function pick<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function readState(): State {
  const q = new URLSearchParams(location.search);
  return {
    view: pick(q.get("view"), ["overview", "tasks", "decisions"], "overview"),
    range: pick(q.get("range"), RANGES, "7d"),
    source: pick(q.get("source"), ["all", "hamness", "claude-code", "codex"], "all"),
    metric: pick(q.get("metric"), ["cost", "tokens", "tasks"], "cost"),
    chartAs: pick(q.get("as"), ["chart", "table"], "chart"),
    outcome: pick(q.get("outcome"), ["all", ...OUTCOMES], "all"),
    turns: q.get("turns") !== "false",
    verdict: pick(q.get("verdict"), ["all", "allow", "ask", "deny"], "all"),
  };
}

let state = readState();

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  const q = new URLSearchParams();
  if (state.view !== "overview") q.set("view", state.view);
  if (state.range !== "7d") q.set("range", state.range);
  if (state.source !== "all") q.set("source", state.source);
  if (state.metric !== "cost") q.set("metric", state.metric);
  if (state.chartAs !== "chart") q.set("as", state.chartAs);
  if (state.outcome !== "all") q.set("outcome", state.outcome);
  if (!state.turns) q.set("turns", "false");
  if (state.verdict !== "all") q.set("verdict", state.verdict);
  history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
  render();
}

// ---- Theme: follows the system, a toggle overrides it ----

type Theme = "system" | "light" | "dark";
const THEME_KEY = "hamness.dashboard.theme";

function storedTheme(): Theme {
  try {
    return pick(localStorage.getItem(THEME_KEY), ["system", "light", "dark"], "system");
  } catch {
    return "system";
  }
}

function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // per-viewer nicety only
  }
}

let theme = storedTheme();
applyTheme(theme);

// ---- Formats ----

const tz = -new Date().getTimezoneOffset();
const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hourLabel = (t: number) => `${pad2(new Date(t).getHours())}:00`;
const dayLabel = (t: number) => `${MONTHS[new Date(t).getMonth()]} ${new Date(t).getDate()}`;
const when = (t: number) => {
  const d = new Date(t);
  return `${dayLabel(t)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const percent = (x: number) => `${Math.round(x * 100)}%`;

// ---- Building blocks ----

/** A row of toggle buttons: the same control for every choice on the page. */
function segmented<T extends string>(
  label: string,
  options: { value: T; text: string }[],
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  return h(
    "div",
    { class: "seg", role: "group", "aria-label": label },
    ...options.map((o) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": o.value === current ? "true" : "false",
          onclick: () => onPick(o.value),
        },
        o.text,
      ),
    ),
  );
}

function tile(label: string, value: string, sub: string, opts: { muted?: boolean } = {}) {
  return h(
    "div",
    { class: "tile" },
    h("div", { class: "tile-label" }, label),
    h("div", { class: `tile-value${opts.muted ? " muted" : ""}` }, value),
    h("div", { class: "tile-sub" }, sub),
  );
}

/** A status mark: always a colored dot plus its name, never color alone. */
const pill = (kind: string, text: string) =>
  h(
    "span",
    { class: `pill pill-${kind}` },
    h("span", { class: "pill-dot", "aria-hidden": "true" }),
    text,
  );

function card(title: string, ...children: (Node | null)[]) {
  return h("section", { class: "card" }, h("h2", { class: "card-title" }, title), ...children);
}

const empty = (text: string) => h("p", { class: "empty" }, text);

/** Ranked rows with a proportional bar behind each. */
function barList(rows: { label: string; value: number; text: string; color?: string }[]) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return h(
    "ul",
    { class: "barlist" },
    ...rows.map((r) => {
      const bar = h("span", { class: "barlist-bar", "aria-hidden": "true" });
      bar.style.width = `${max > 0 ? Math.max(1, (r.value / max) * 100) : 0}%`;
      if (r.color) bar.dataset.color = r.color;
      return h(
        "li",
        {},
        bar,
        h("span", { class: "barlist-label" }, r.label),
        h("span", { class: "barlist-value" }, r.text),
      );
    }),
  );
}

// ---- Overview ----

const METRICS: Record<
  Metric,
  {
    label: string;
    value: (b: StatsReport["series"]["buckets"][number]) => number;
    format: (v: number) => string;
  }
> = {
  cost: { label: "Cost", value: (b) => b.costMicros, format: (v) => money(Math.round(v)) },
  tokens: { label: "Tokens", value: (b) => b.tokens, format: (v) => count(Math.round(v)) },
  tasks: { label: "Tasks", value: (b) => b.tasks, format: (v) => count(Math.round(v)) },
};

function overview(r: StatsReport): Node[] {
  const k = r.kpis;
  const imported = r.source !== null && r.source !== "hamness";
  const est = k.pricing.estimated ? "~" : "";
  const closed = k.tasks.total - k.tasks.open;

  const tiles = h(
    "div",
    { class: "tiles" },
    tile(
      "Cost",
      `${est}${money(k.costMicros)}`,
      `${count(k.modelCalls)} model ${k.modelCalls === 1 ? "call" : "calls"}`,
    ),
    imported
      ? tile("Tasks", "n/a", "n/a for imported history", { muted: true })
      : tile(
          "Tasks",
          count(k.tasks.total),
          `${count(k.tasks.verified)} verified, ${count(k.tasks.open)} open`,
        ),
    k.verifiedRate === null
      ? tile(
          "Verified rate",
          "n/a",
          imported ? "n/a for imported history" : "no closed tasks yet",
          {
            muted: true,
          },
        )
      : tile("Verified rate", percent(k.verifiedRate), `of ${count(closed)} closed tasks`),
    k.costPerVerifiedTaskMicros === null
      ? tile(
          "Cost per verified task",
          "n/a",
          imported ? "n/a for imported history" : "no verified tasks yet",
          { muted: true },
        )
      : tile(
          "Cost per verified task",
          money(k.costPerVerifiedTaskMicros),
          "hamness spend over verified tasks",
        ),
    k.activeSessions > 0
      ? tile(
          "Active time",
          duration(k.activeMs),
          // Sessions without active time (imported old-format ones) are not in the sum, so
          // the count says how many are, against the total By source shows.
          `${
            k.activeSessions < k.sessions
              ? `${count(k.activeSessions)} of ${count(k.sessions)} sessions with time recorded`
              : `${count(k.sessions)} ${k.sessions === 1 ? "session" : "sessions"}`
          }; wall time summed: ${duration(k.wallMs)}`,
        )
      : tile(
          "Wall time (summed)",
          duration(k.wallMs),
          `sum over ${count(k.sessions)} ${k.sessions === 1 ? "session" : "sessions"}`,
        ),
  );

  const m = METRICS[state.metric];
  const points = r.series.buckets.map((b) => ({ start: b.start, value: m.value(b) }));
  const hourly = r.range === "24h" || r.range === "today";
  const heroControls = h(
    "div",
    { class: "card-controls" },
    segmented(
      "Chart metric",
      (Object.keys(METRICS) as Metric[]).map((v) => ({ value: v, text: METRICS[v].label })),
      state.metric,
      (metric) => setState({ metric }),
    ),
    segmented(
      "Show as",
      [
        { value: "chart", text: "Chart" },
        { value: "table", text: "Table" },
      ],
      state.chartAs,
      (chartAs) => setState({ chartAs }),
    ),
  );
  const body =
    state.chartAs === "chart"
      ? areaChart({
          points,
          label: m.label,
          format: m.format,
          tick: hourly ? hourLabel : dayLabel,
          title: hourly ? (t) => `${dayLabel(t)}, ${hourLabel(t)}` : dayLabel,
          partialLast: true,
        })
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("caption", { class: "sr-only" }, `${m.label} per ${hourly ? "hour" : "day"}`),
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { scope: "col" }, hourly ? "Hour" : "Day"),
                h("th", { scope: "col", class: "num" }, m.label),
              ),
            ),
            h(
              "tbody",
              {},
              ...[...points]
                .reverse()
                .map((p) =>
                  h(
                    "tr",
                    {},
                    h(
                      "td",
                      {},
                      hourly ? `${dayLabel(p.start)}, ${hourLabel(p.start)}` : dayLabel(p.start),
                    ),
                    h("td", { class: "num" }, m.format(p.value)),
                  ),
                ),
            ),
          ),
        );
  const hero = h(
    "section",
    { class: "card hero" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { class: "card-title" }, `${m.label} per ${hourly ? "hour" : "day"}`),
      heroControls,
    ),
    body,
    state.chartAs === "chart"
      ? h(
          "p",
          { class: "caption" },
          `The dashed segment is the current ${hourly ? "hour" : "day"}, still filling.`,
        )
      : null,
  );

  const sources = card(
    "By source",
    r.sources.some((x) => x.costMicros > 0 || x.sessions > 0)
      ? barList(
          r.sources.map((x) => ({
            label: SOURCE_LABEL[x.source],
            value: x.costMicros,
            text: `${x.source === "hamness" ? "" : est}${money(x.costMicros)} · ${count(x.sessions)} sessions`,
            color: x.source,
          })),
        )
      : empty("No sessions in this range."),
  );
  const models = card(
    "Top models",
    r.models.length
      ? barList(
          r.models.map((x) => ({
            label: x.priced ? x.model : `${x.model} *`,
            value: x.calls,
            text: `${count(x.calls)} calls · ${x.sources.some((src) => src !== "hamness") ? "~" : ""}${money(x.costMicros)}`,
          })),
        )
      : empty("No model calls in this range."),
  );
  const d = r.decisions;
  const decisions = card(
    "Safety decisions",
    d.total
      ? h(
          "div",
          {},
          h(
            "div",
            { class: "verdicts" },
            pill("good", `${count(d.allow)} allow`),
            pill("warning", `${count(d.ask)} ask`),
            pill("critical", `${count(d.deny)} deny`),
          ),
          barList(
            d.bySource.map((x) => ({
              label: `by ${x.source}`,
              value: x.total,
              text: count(x.total),
            })),
          ),
        )
      : empty("No decisions in this range."),
  );

  const notes: string[] = [];
  if (k.pricing.estimated) notes.push("~ Cost of imported history is estimated from token counts.");
  if (k.pricing.unpricedCalls > 0)
    notes.push(
      `* ${count(k.pricing.unpricedCalls)} calls of models with no known price count as $0: ${k.pricing.unpricedModels.join(", ")}.`,
    );
  if (r.source === null)
    notes.push("Tasks, verified rate and cost per verified task cover hamness sessions only.");

  return [
    tiles,
    hero,
    h("div", { class: "grid3" }, sources, models, decisions),
    notes.length ? h("ul", { class: "notes" }, ...notes.map((n) => h("li", {}, n))) : null,
  ].filter((x): x is HTMLElement => x !== null);
}

// ---- Tasks ----

const OUTCOME_KIND: Record<TaskOutcome, string> = {
  verified: "good",
  unverified: "warning",
  overridden: "serious",
  abandoned: "neutral",
  open: "info",
};
const EVIDENCE_KIND: Record<EvidenceRow["status"], string> = {
  passed: "good",
  failed: "critical",
  error: "serious",
  pending: "neutral",
};

function evidenceCell(t: TaskListRow): string {
  const e = t.evidence;
  if (e.checked === 0 && e.pending === 0) return "none";
  return `${e.passed}/${e.checked} passed${e.pending ? `, ${e.pending} pending` : ""}`;
}

/** The task's branch, commit and PR (P-L4), as detail lines. A PR links only to an https URL. */
function links(t: TaskListRow): HTMLElement[] {
  const out: HTMLElement[] = [];
  const line = (label: string, ...value: Array<Node | string>) =>
    out.push(h("p", { class: "link" }, h("strong", {}, `${label}: `), ...value));
  if (t.branch) line("Branch", h("code", {}, t.branch));
  if (t.commitSha) line("Commit", h("code", {}, t.commitSha.slice(0, 12)));
  if (t.prUrl?.startsWith("https://")) {
    line(
      "PR",
      h("a", { class: "pr", href: t.prUrl, target: "_blank", rel: "noopener noreferrer" }, t.prUrl),
    );
  }
  return out;
}

function taskRows(t: TaskListRow): HTMLTableRowElement[] {
  const detailId = `task-${t.id}`;
  const detail = h("tr", { class: "detail", id: detailId, hidden: true }, h("td", { colspan: 6 }));
  const toggle = h(
    "button",
    { type: "button", class: "rowbtn", "aria-expanded": "false", "aria-controls": detailId },
    t.goal,
  );
  toggle.addEventListener("click", async () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    detail.hidden = !open;
    if (!open || detail.dataset.loaded) return;
    detail.dataset.loaded = "1";
    const cell = detail.firstElementChild as HTMLElement;
    cell.replaceChildren(h("p", { class: "muted" }, "Loading evidence..."));
    try {
      const { evidence } = await getJson<{ evidence: EvidenceRow[] }>(
        `/v1/tasks/${encodeURIComponent(t.id)}/evidence`,
      );
      cell.replaceChildren(
        ...(t.reason ? [h("p", {}, h("strong", {}, "Reason: "), t.reason)] : []),
        ...(t.summary ? [h("p", {}, h("strong", {}, "Summary: "), t.summary)] : []),
        ...links(t),
        evidence.length
          ? h(
              "ul",
              { class: "evidence" },
              ...evidence.map((e) =>
                h(
                  "li",
                  {},
                  pill(EVIDENCE_KIND[e.status], e.status),
                  h("code", {}, `${e.kind}: ${e.claim}`),
                  e.summary ? h("span", { class: "muted" }, e.summary) : null,
                ),
              ),
            )
          : h("p", { class: "muted" }, "No evidence was submitted for this task."),
      );
    } catch (err) {
      delete detail.dataset.loaded;
      cell.replaceChildren(
        h("p", { class: "error" }, `Could not load evidence: ${(err as Error).message}`),
      );
    }
  });
  const row = h(
    "tr",
    {},
    h(
      "td",
      { class: "goal" },
      toggle,
      t.implicit ? h("span", { class: "tag" }, "turn") : null,
      t.source !== "hamness" ? h("span", { class: "tag" }, SOURCE_LABEL[t.source]) : null,
    ),
    h("td", { class: "hide-sm" }, when(t.startedAt)),
    h("td", { class: "num" }, money(t.costMicros)),
    h("td", { class: "num hide-sm" }, duration(t.durationMs)),
    h("td", {}, pill(OUTCOME_KIND[t.outcome], t.outcome)),
    h("td", { class: "num" }, evidenceCell(t)),
  );
  return [row, detail];
}

async function tasksView(): Promise<Node[]> {
  const filters = h(
    "div",
    { class: "filters" },
    segmented(
      "Outcome",
      [{ value: "all" as const, text: "All" }, ...OUTCOMES.map((o) => ({ value: o, text: o }))],
      state.outcome,
      (outcome) => setState({ outcome }),
    ),
    segmented(
      "Turn tasks",
      [
        { value: "shown", text: "With turns" },
        { value: "hidden", text: "Explicit only" },
      ],
      state.turns ? "shown" : "hidden",
      (v) => setState({ turns: v === "shown" }),
    ),
  );
  const tbody = h("tbody", {});
  const more = h("button", { type: "button", class: "more", hidden: true }, "Load more");
  const params = {
    range: state.range,
    source: state.source,
    tz,
    outcome: state.outcome === "all" ? undefined : state.outcome,
    turns: state.turns ? undefined : false,
    limit: 50,
  };
  const load = async (cursor?: string) => {
    const page = await getJson<Page<TaskListRow>>("/v1/tasks", { ...params, cursor });
    for (const t of page.rows) tbody.append(...taskRows(t));
    more.hidden = !page.nextCursor;
    more.onclick = page.nextCursor ? () => void load(page.nextCursor ?? undefined) : null;
    return page;
  };
  const first = await load();
  const table = first.rows.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "tasks" },
          h(
            "caption",
            { class: "sr-only" },
            "Tasks, newest first. Open a goal to see its evidence.",
          ),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, "Goal"),
              h("th", { scope: "col", class: "hide-sm" }, "Started"),
              h("th", { scope: "col", class: "num" }, "Cost"),
              h("th", { scope: "col", class: "num hide-sm" }, "Time"),
              h("th", { scope: "col" }, "Outcome"),
              h("th", { scope: "col", class: "num" }, "Evidence"),
            ),
          ),
          tbody,
        ),
      )
    : empty(
        state.source === "claude-code" || state.source === "codex"
          ? "Imported history has no tasks: tasks are recorded by hamness sessions."
          : `No tasks ${inRange(state.range)}.`,
      );
  return [card("Tasks", filters, table, more)];
}

// ---- Decisions ----

const VERDICT_KIND = { allow: "good", ask: "warning", deny: "critical" } as const;

/**
 * The call as `hamness audit` prints it (redacted, cut short), the full text in its title.
 * A cut call opens to its full text on click.
 */
function callCell(d: DecisionListRow): HTMLElement {
  const code = h("code", { title: d.callFull }, d.call);
  if (d.call === d.callFull) return h("td", { class: "call" }, code);
  const toggle = h(
    "button",
    {
      type: "button",
      class: "callbtn",
      "aria-expanded": "false",
      "aria-label": "Show the full call",
    },
    code,
  );
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Show the short call" : "Show the full call");
    code.textContent = open ? d.callFull : d.call;
  });
  return h("td", { class: "call" }, toggle);
}

async function decisionsView(): Promise<Node[]> {
  const filters = h(
    "div",
    { class: "filters" },
    segmented(
      "Verdict",
      [
        { value: "all" as const, text: "All" },
        { value: "allow" as const, text: "allow" },
        { value: "ask" as const, text: "ask" },
        { value: "deny" as const, text: "deny" },
      ],
      state.verdict,
      (verdict) => setState({ verdict }),
    ),
  );
  const tbody = h("tbody", {});
  const more = h("button", { type: "button", class: "more", hidden: true }, "Load more");
  const params = {
    range: state.range,
    source: state.source,
    tz,
    verdict: state.verdict === "all" ? undefined : state.verdict,
    limit: 100,
  };
  const load = async (cursor?: string) => {
    const page = await getJson<Page<DecisionListRow>>("/v1/decisions", { ...params, cursor });
    for (const d of page.rows)
      tbody.append(
        h(
          "tr",
          {},
          h("td", {}, when(d.createdAt)),
          h("td", {}, h("code", {}, d.tool)),
          callCell(d),
          h("td", {}, pill(VERDICT_KIND[d.verdict], d.verdict)),
          h("td", {}, d.decidedBy),
          h("td", { class: "hide-sm" }, d.sessionSource ? SOURCE_LABEL[d.sessionSource] : "none"),
          h(
            "td",
            { class: "reason" },
            d.reason ?? "",
            d.rule ? h("div", { class: "muted" }, h("code", {}, d.rule)) : null,
          ),
        ),
      );
    more.hidden = !page.nextCursor;
    more.onclick = page.nextCursor ? () => void load(page.nextCursor ?? undefined) : null;
    return page;
  };
  const first = await load();
  const table = first.rows.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("caption", { class: "sr-only" }, "Safety decisions, newest first"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, "Time"),
              h("th", { scope: "col" }, "Tool"),
              h("th", { scope: "col" }, "Call"),
              h("th", { scope: "col" }, "Verdict"),
              h("th", { scope: "col" }, "Decided by"),
              h("th", { scope: "col", class: "hide-sm" }, "Source"),
              h("th", { scope: "col" }, "Reason"),
            ),
          ),
          tbody,
        ),
      )
    : empty(`No safety decisions ${inRange(state.range)}.`);
  return [card("Safety decisions", filters, table, more)];
}

// ---- Shell ----

const app = document.getElementById("app") as HTMLElement;
const VIEW_TITLE: Record<View, string> = {
  overview: "Overview",
  tasks: "Tasks",
  decisions: "Safety decisions",
};
let generation = 0;

function header(): HTMLElement {
  const themeText: Record<Theme, string> = {
    system: "Theme: system",
    light: "Theme: light",
    dark: "Theme: dark",
  };
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const toggle = h(
    "button",
    { type: "button", class: "theme", "aria-label": `${themeText[theme]}. Change theme` },
    themeText[theme],
  );
  toggle.addEventListener("click", () => {
    theme = next[theme];
    applyTheme(theme);
    toggle.textContent = themeText[theme];
    toggle.setAttribute("aria-label", `${themeText[theme]}. Change theme`);
  });
  const tabs: { value: View; text: string }[] = [
    { value: "overview", text: "Overview" },
    { value: "tasks", text: "Tasks" },
    { value: "decisions", text: "Decisions" },
  ];
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), "hamness"),
    h(
      "nav",
      { "aria-label": "Views" },
      ...tabs.map((t) =>
        h(
          "button",
          {
            type: "button",
            class: "tab",
            "aria-current": t.value === state.view ? "page" : false,
            onclick: () => setState({ view: t.value }),
          },
          t.text,
        ),
      ),
    ),
    toggle,
  );
}

function controls(): HTMLElement {
  return h(
    "div",
    { class: "controls" },
    segmented(
      "Range",
      RANGES.map((r) => ({ value: r, text: r })),
      state.range,
      (range) => setState({ range }),
    ),
    segmented(
      "Source",
      [
        { value: "all" as const, text: "All" },
        ...(Object.keys(SOURCE_LABEL) as Source[]).map((v) => ({
          value: v,
          text: SOURCE_LABEL[v],
        })),
      ],
      state.source,
      (source) => setState({ source }),
    ),
  );
}

function signedOut(): HTMLElement {
  return h(
    "div",
    { class: "card signed-out" },
    h("h1", {}, "Open the dashboard from the terminal"),
    h(
      "p",
      {},
      "This page needs the daemon's token. Run ",
      h("code", {}, "hamness dashboard"),
      " to open it with one.",
    ),
  );
}

async function render(): Promise<void> {
  const mine = ++generation;
  if (!takeToken()) {
    app.replaceChildren(signedOut());
    return;
  }
  // The new view's own heading and a quiet line until its data is in: the old view's content
  // is gone the moment the view changes, and a stale answer never lands (`generation`).
  const main = h(
    "main",
    { id: "main", "aria-busy": "true" },
    card(
      VIEW_TITLE[state.view],
      h(
        "p",
        { class: "loading", role: "status" },
        `Loading ${VIEW_TITLE[state.view].toLowerCase()}…`,
      ),
    ),
  );
  app.replaceChildren(header(), controls(), main);
  try {
    let content: Node[];
    if (state.view === "overview") {
      const report = await getJson<StatsReport>("/v1/stats", {
        range: state.range,
        source: state.source,
        tz,
      });
      if (mine !== generation) return;
      content = overview(report);
    } else if (state.view === "tasks") content = await tasksView();
    else content = await decisionsView();
    if (mine !== generation) return;
    const title = h(
      "h1",
      { class: "sr-only" },
      `${state.view[0]?.toUpperCase()}${state.view.slice(1)}, ${RANGE_LABEL[state.range]}`,
    );
    main.replaceChildren(title, ...content);
  } catch (err) {
    if (mine !== generation) return;
    if (err instanceof Unauthorized) app.replaceChildren(signedOut());
    else
      main.replaceChildren(
        h("p", { class: "error", role: "alert" }, `Could not load: ${(err as Error).message}`),
      );
  } finally {
    main.removeAttribute("aria-busy");
  }
}

void render();
