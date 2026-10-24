# 0014: The judge's budget and back-off live outside the model call

**Status:** accepted, 2026-10-24

The judge is two parts: the model call (`src/safety/judge/anthropic.ts`, strict verdict, fails closed) and a controller (`controller.ts`) that adds the deadline, the daily budget and the back-off. The budget is the sum of stored `judge` decision costs since local midnight, so it survives restarts and needs no extra table. The back-off (3 asks in a row) is per session and in memory: a restart or `/judge resume` clears it. When the judge does not run (paused, over budget, no key) the decision is stored with source `mode`, not `judge`, so judge stats count only real judge calls.
