# 0015: Background subagents, optionally in their own git worktree

**Status:** accepted, 2026-10-24

The main agent starts subagents with three tools: `agent_start({name, prompt, model?, worktree?})` returns an id at once, `agent_status({id})` looks, and `agent_wait({id, timeoutSec?})` blocks until the subagent finishes (default 300 s, at most 3600 s; on a timeout the status is still `running`). Each subagent is its own Pi loop (`AgentRunner`) in the daemon, with its own `agents` row (`kind = 'subagent'`, `parent_agent_id`, `name`, `model`, `status`, `worktree_path`), its own `agentId` on every event, and the same safety check as the main agent, run in the subagent's cwd. Subagents don't get the agent tools or the task tools themselves: one level only, for now, and the task belongs to the parent. Claude Code hooks: a subagent's tool calls meet the PreToolUse hooks (they are part of the safety check), but subagents fire no UserPromptSubmit, PostToolUse or Stop hooks; those belong to the user's session.

**Results.** When a subagent finishes, its final message goes back to the parent in one of two ways. If an `agent_wait` is waiting, it is that tool call's result. If not, it goes into the parent's context as a notice (Pi's `sendCustomMessage` with `triggerTurn: false`): during a run it lands after the current turn, otherwise the next prompt's first model call sees it. A notice never starts a turn on its own, so a finished subagent costs nothing until the user or the parent acts.

**Cost.** A subagent's model calls carry the `task_id` of the parent's open task when it was started (also stored on its `agents` row), so its cost rolls up to that task. An implicit per-turn task that started subagents is kept when its turn ends (it closes `unverified` without passing evidence) rather than dropped, so their later rows still have a task to count toward. Session totals (`snapshot.agents`, the rail's session cost) include subagents already.

**Concurrency.** At most 4 subagents run at once across the daemon (`maxSubagents`); more wait in a queue, oldest first. Stopping the parent (Esc, `POST /v1/sessions/:id/abort`) stops its running subagents and drops its queued ones (status `aborted`, no notice). Subagents a previous daemon left `queued` or `running` are marked `aborted` at start.

**Worktrees.** With `worktree: true`, hamness runs `git worktree add -b hamness/<name>-<short id> <path> HEAD` from the parent's repo, and the subagent's cwd is that path:

    <repo-parent>/<repo>.hamness-worktrees/<name>-<short id>

Next to the repo rather than in the data dir, because the default rules deny reads and writes in the data dir, and rather than inside the repo, where it would show as untracked files. Writes outside the worktree get no free pass: the `$CWD/**` write rule now means the worktree, so anything else asks (or is denied) like any write outside a session's dir. The worktree starts from the parent's last commit; uncommitted changes in the parent's checkout are not in it.

`hamness worktrees` lists them (name, status, branch, path). `--prune` removes the worktrees of finished subagents with a plain `git worktree remove`: the branch stays, and a worktree with uncommitted changes is kept, so pruning never loses work.

The agent tools are allowed by the default rules: starting a subagent grants nothing new, since each of its tool calls passes the same rules.

Consequences: parallel agents can't trample one checkout, every subagent shows as a rail row with its name, and its spend counts against the task it worked for. Merging a subagent's branch back is left to the parent agent or the user (git, a PR).
