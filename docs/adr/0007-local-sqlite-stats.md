# 0007: Stats live in local SQLite; sync comes later

**Status:** accepted, 2026-10-24

All data goes into one local SQLite file. Nothing leaves the machine. Stable ids and `updated_at` columns keep a later sync to self-hosted Postgres (Supabase first) possible. Imported Claude Code and Codex history stores counts, tokens, models and timings, not message text.
