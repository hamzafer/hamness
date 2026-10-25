# 0022: yolo skips questions, not deny rules

**Status:** accepted, 2026-10-25

The spec first said `yolo` meant "allow all": the safety service allowed every call before the rules ran, so an end-to-end run in yolo mode read a `.env` file, recorded as source `mode`, "yolo mode allows every call". The owner decided that is too much: yolo is for not being asked, not for turning off the floor.

**Decision.** In `yolo` the rules still run first. A `deny` rule, default or user (and a trusted project's, as ever), denies the call with source `rule`, as in any mode: secrets and `.env` reads, `sudo`, `curl | sh`, `rm -rf ~` and the like. Everything else runs with no question: undecided calls (no judge call), `ask` rules (`rm -rf`, force pushes, writes to `.env` or `.git`) and the doom-loop check. A call a rule allows is recorded with source `rule`; the rest with source `mode`, "yolo mode allows it (no deny rule matched)".

**The floor still asks.** Some calls the engine turns from a deny into an ask because it cannot see past them. In yolo these ask the user instead of running, recorded with source `mode` and a reason starting "yolo still asks: ". The rule engine marks them on the evaluation (`floor`):
- a recursive read over a folder that holds a denied path (`grep -r S .` next to a `.env`, `rg --hidden`, `rg -uu`, `grep -rl S ~`, Pi's grep or find tool over such a folder);
- a command it could not parse (a heredoc) or that nests too deep;
- a file reader given a path only known at run time (`F=.env; cat $F`, `cat $(…)`, a `<` redirect from `$X`);
- a glob with more matches than it checks, or a walk over more files than it lists.

The owner's call: keep yolo usable, but never silently read secrets.

**Limits.** Deny rules block direct references to secrets; yolo can't see inside scripts and interpreters. `python3 -c "open('.env')"`, `xargs cat <<< .env` or `tar cf - .` are not caught: the engine does not model what an interpreter or a generic tool reads. The banner, README and this ADR say so.

**What yolo still does not skip.** A Claude Code hook's `deny` (final) or `ask` (still asks), and the proof gate's "count `X` as proof?" question (ADR 0019), which is about evidence, not safety.

Consequences: a user who wants a call to run in yolo that a default rule denies has to change the rule, not the mode. The yolo banner says deny rules still apply and what yolo can't see.
