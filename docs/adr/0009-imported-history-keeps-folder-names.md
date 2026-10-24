# 0009: Imported history keeps folder names, not paths

**Status:** accepted, 2026-10-24

`hamness import` stores only the last folder of a session's working directory in `sessions.cwd` (`/home/me/dev/app` becomes `app`), never the full path, so the database holds no home paths or user names. Source files are tracked in `import_files` by a SHA-256 of their path for the same reason. Two projects with the same folder name share a label in stats; that is the accepted cost. Tool arguments and message text are not stored either (ADR 0007), so `tool_calls.args_json` stays NULL for imported rows.

Imported cost is an estimate: tokens of each model call priced from `src/models/prices.ts`. Models without a price (local models, unknown ids) cost 0.
