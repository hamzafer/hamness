import { parsePermission, type Rule } from "./rules.ts";

/**
 * The built-in rules, written in the same format as a config file's `permission` block.
 * Order matters: the last matching rule wins, so exceptions come after the broad rules.
 * Calls no rule matches are undecided: in `ask` mode the user decides, in `auto` the judge.
 */

const SECRETS = [
  "**/.env",
  "**/.env.*",
  "~/.ssh{,/**}",
  "~/.aws{,/**}",
  "~/.gnupg{,/**}",
  "~/.config/gh{,/**}",
  "~/.docker/config.json",
  "~/.kube/config",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "**/*.pem",
  "**/*.key",
  "**/id_{rsa,ed25519,ecdsa,dsa}{,.pub}",
];

const deny = (patterns: string[]) => Object.fromEntries(patterns.map((p) => [p, "deny"]));

/** Read-only commands that run without asking. Anything they could write goes through other rules. */
const READ_ONLY = [
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "rg *",
  "pwd *",
  "echo *",
  "which *",
  "stat *",
  "tree *",
  "git status *",
  "git diff *",
  "git log *",
  "git show *",
];

export const DEFAULT_PERMISSION = {
  // hamness's own task tools (ticket #6). A `prove` command re-run gets its own bash check.
  "{task_start,task_done,prove}": "allow",
  "{read,grep,find,ls}": {
    "*": "allow",
    ...deny(SECRETS),
    "**/.env.{example,sample,template}": "allow",
    "$DATA{,/**}": "deny",
  },
  "{write,edit}": {
    "$CWD/**": "allow",
    "**/.env": "ask",
    "**/.env.*": "ask",
    "$CWD/.git{,/**}": "ask",
    "$CWD/.hamness{,/**}": "ask",
    ...deny(SECRETS.filter((p) => !p.startsWith("**/.env"))),
    "$DATA{,/**}": "deny",
  },
  bash: {
    ...Object.fromEntries(READ_ONLY.map((p) => [p, "allow"])),
    // Flags that make an allowed command write or run something.
    "git * --output*": "ask",
    "rg *--pre*": "ask",
    "tree *-o *": "ask",
    // Recursive deletes.
    "rm -*r*": "ask",
    "rm -*R*": "ask",
    "rm * -*r*": "ask",
    "rm * -*R*": "ask",
    "rm *--recursive*": "ask",
    // History rewrites.
    "git push *--force*": "ask",
    "git push *-f": "ask",
    "git push *-f *": "ask",
    "git push * +*": "ask",
    "git push *--mirror*": "ask",
    "git push *--delete*": "ask",
    "git reset --hard*": "ask",
    "git clean *-*f*": "ask",
    "chmod -R *": "ask",
    "chown *": "ask",
    "dd *": "ask",
    // Never.
    "{sudo,doas,su} *": "deny",
    "rm {-rf,-fr,-Rf,-fR,-r -f,-f -r,--recursive --force,--force --recursive} {/,/\\*,~,~/,~/\\*,$HOME,$HOME/,$HOME/\\*} *":
      "deny",
    "mkfs*": "deny",
    "*{curl,wget} * | {sh,bash,zsh,dash,fish} *": "deny",
  },
  // Loads a skill's instructions (text) into the context.
  skill: "allow",
  // Pi's MCP resource tools only list and read. Server tools (`mcp__<server>__*`) stay undecided:
  // a tool's name says nothing reliable about what it does.
  "{list_mcp_resources,list_mcp_resource_templates,read_mcp_resource}": "allow",
  // Subagents (ADR 0015): starting one is safe to allow, since each of its tool calls passes
  // these same rules in its own cwd; status and wait only read.
  "{agent_start,agent_status,agent_wait}": "allow",
} as const;

export function defaultRules(): Rule[] {
  return parsePermission(DEFAULT_PERMISSION, "default");
}
