# 0022: yolo skips questions, not deny rules

**Status:** accepted, 2026-10-25

The spec first said `yolo` meant "allow all": the safety service allowed every call before the rules ran, so an end-to-end run in yolo mode read a `.env` file, recorded as source `mode`, "yolo mode allows every call". The owner decided that is too much: yolo is for not being asked, not for turning off the floor.

**Decision.** In `yolo` the rules still run first. A `deny` rule, default or user (and a trusted project's, as ever), denies the call with source `rule`, as in any mode: secrets and `.env` reads, `sudo`, `curl | sh`, `rm -rf ~` and the like. Everything else runs with no question: undecided calls (no judge call), `ask` rules (`rm -rf`, force pushes, writes to `.env` or `.git`) and the doom-loop check. A call a rule allows is recorded with source `rule`; the rest with source `mode`, "yolo mode allows it (no deny rule matched)".

**What yolo still does not skip.** A Claude Code hook's `deny` (final) or `ask` (still asks), and the proof gate's "count `X` as proof?" question (ADR 0019), which is about evidence, not safety.

Consequences: a user who wants a call to run in yolo that a default rule denies has to change the rule, not the mode. The yolo banner says deny rules still apply.
