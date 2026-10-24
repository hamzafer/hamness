/**
 * Stats: queries over the local database for `hamness stats` and the dashboard (ADR 0007).
 * Every function takes the SQLite handle and a `StatsQuery` and returns plain data.
 */
export * from "./queries.ts";
export * from "./rows.ts";
export * from "./window.ts";
