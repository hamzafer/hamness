# 0005: A hard proof gate, checked by hamness

**Status:** accepted, 2026-10-24

A task is `verified` only when at least one piece of evidence passed a hamness checker: hamness re-runs the command, reads CI itself, checks the file or fetches the URL. The agent can submit evidence but never write its result. Without proof a task is `unverified`; only the user can override it. This is what makes "done" mean something.
