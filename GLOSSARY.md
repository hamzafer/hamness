# Glossary

- **Daemon:** the long-running hamness process. It owns sessions, agents, the database and the event stream.
- **Client:** anything that attaches to the daemon: the TUI or the web dashboard.
- **Session:** a conversation with a main agent in one working directory.
- **Agent:** one running Pi agent loop. The main agent belongs to a session; **subagents** are started by an agent, often in the background.
- **Worktree:** a git worktree a subagent can run in, so parallel agents don't edit the same checkout.
- **Task:** the unit of work and of accounting: goal, agents, cost, tokens, time, evidence, outcome.
- **Outcome:** a task's final state: `open`, `verified`, `unverified`, `overridden` (the user accepted it without proof), `abandoned`.
- **Evidence:** a claim attached with the `prove` tool (`command`, `ci`, `file`, `url`), checked by a **checker**.
- **Checker:** hamness code that verifies a piece of evidence on its own. Only checkers write evidence results.
- **Proof gate:** the rule that a task becomes `verified` only with at least one passing piece of evidence.
- **Rule:** an allow / ask / deny pattern for a tool call.
- **Judge:** the small model that decides tool calls no rule decides.
- **Decision:** a safety verdict on one tool call, with source (`rule`, `judge`, `hook`, `user`, `mode`) and reason.
- **Audit log:** the stored list of decisions.
- **Side rail:** the always-on right pane in the TUI showing agents, shells, checks, the current task and gauges.
- **Source:** where a session came from: `hamness`, `claude-code` or `codex` (imported).
