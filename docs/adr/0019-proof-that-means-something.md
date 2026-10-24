# 0019: Proof that means something

**Status:** accepted, 2026-10-24. Refines ADRs 0005 and 0012.

ADR 0005 made `verified` mean "a hamness checker passed a piece of evidence". The v1 review showed that was too easy to satisfy: `prove(command: "echo ok")` passed, the re-run used the read-only bash allow list so nobody was asked, a URL fetch could carry data anywhere, CI from any repo counted, and one early pass verified a task whatever came after. This ADR sets what counts.

**A command must be able to prove something.** `parseClaim` refuses, before anything runs:
- commands joined by `||`, `;`, a new line or `&`, and `!`: they can turn a failure into exit 0. Only `&&` and `|` join commands, and a pipe runs under bash's `pipefail`;
- words known only at run time (`$VAR`, `$(...)`, backticks);
- no-ops that set the exit code (`true`, `:`, `exit`, `set`, `trap`, ...) and flags that only print (`--help`, `--version`, `--collect-only`, `--passWithNoTests`, ...);
- commands made only of read-only or printing parts (`echo`, `printf`, `cat`, `ls`, `grep`, `test`, `git status` ...). A `sh -c` string is looked into.

A run that exits 0 but shows that no tests ran (`Ran 0 tests`, `no tests to run`, `No tests found`, only `running 0 tests` lines) fails.

**The proof command list.** The re-run is checked as its own tool, `prove_command`, not as `bash`. bash's deny and ask rules still apply to every part; bash allow rules from the user or the project don't ("safe to run" is not "proof"). It runs without asking only when every part is on the list (or is a read-only helper: `cd`, the built-in read-only commands). The list: built-in test runners, builds, linters and typecheckers (`bun test`, `npm test`, `npm run build`, `pnpm test`, `cargo test`, `go test`, `pytest`, `make test`, `tsc`, `biome check`, `eslint` and their kin, see `src/safety/proof.ts`), the user config's `proof.commands`, and the project's `.hamness/config.json` `proof.commands`, each counted only once trusted (`hamness trust`, ADR 0020). Anything else asks the user: "count `X` as proof?". This is the user's call in every mode: the judge never decides it and `yolo` does not skip it. "Allow always" adds the pattern to the user's `proof.commands`, never the project's, so a repo can't grow the list.

**A URL is a request out.** `prove url` passes safety as `prove_url`: no rule allows it by default, so the judge or the user decides (URL rules match the URL; "allow always" offers its origin). Hosts that resolve to loopback, private, link-local, CGNAT or other internal addresses are refused unless the user config sets `proof.allowPrivateUrls` (a local dev server). Redirects are followed by hand, only on the same host, each hop checked again. Known gap: the name is resolved before fetch resolves it again, so DNS rebinding is not caught.

**CI must be about this work.** The repo must be the session folder's GitHub repo (`gh repo view`). A commit must be in HEAD's history; a PR's head branch must be the current branch and its head commit in HEAD's history. Passing CI fills the task's PR URL and commit (shown in the dashboard with the branch the task started on).

**Files.** File evidence must be inside the session folder, symlinks resolved. A file the agent wrote with its own `write` / `edit` tools in the task is **weak**: it can pass, but never verifies a task alone. (A file written through `bash` is not detected as weak; file evidence shows an artifact exists, not that it is right.)

**The gate reads the latest evidence.** A task is verified only when the latest decided piece (passed or failed; `error` checked nothing and is skipped) passed, the latest strong piece (not weak) passed, and that pass was submitted after the task's last `write` / `edit` by any of its agents (one still running counts as now). So: fail after pass is unverified, an edit after the proof needs a new proof. `task_done` says why a task closed unverified. An implicit task closes unverified only with failed evidence, edits or subagents; one whose only evidence is `error` is dropped with that evidence (ADR 0012 updated).

**The rail shows checks.** Each checker run emits `check.start` and `check.end` and gets its own rail row (the newest three). Background shells have no rows: Pi's `bash` tool has no background mode (it waits for every command), so there is nothing to show; they come when Pi or a hamness tool adds one.

Consequences: agents must prove with real checks, and a repo whose checks are not on the list asks once per pattern. What a listed command runs is still up to the repo (an `npm test` script can be `exit 0`, and the agent can edit it); the list says which commands count, not that the repo's tests are good.
