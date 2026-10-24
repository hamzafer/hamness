# 0002: Pi is the agent loop, used as a library

**Status:** accepted, 2026-10-24

We embed Pi (MIT, TypeScript, many providers, branchable sessions) instead of writing our own loop or driving Codex's app-server. OpenClaw embeds it the same way. Our effort goes into tasks, proof, safety and stats. If Pi blocks a core need (for example, wrapping tools with a safety check), we patch upstream or wrap it, and record that in a new ADR.
