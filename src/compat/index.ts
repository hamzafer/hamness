import { join } from "node:path";
import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findInstructions, type InstructionsResult } from "./instructions.ts";
import { loadMcpServers, type McpResult } from "./mcp.ts";
import type { ClaudeEnv } from "./paths.ts";
import { discoverSkills, renderSkill, type SkillsResult, skillsPrompt } from "./skills.ts";

/**
 * Claude Code compatibility: reads CLAUDE.md, AGENTS.md, skills and MCP config in Claude Code's
 * formats, so a user's setup works in hamness as it is. Never writes to them (ADR 0008).
 */

export { approveProjectServers, revokeProjectServers } from "./approvals.ts";
export type { ClaudeHooks, HookSession, PreToolOutcome } from "./hooks.ts";
export { createClaudeHooks, isProjectTrusted, trustProject } from "./hooks.ts";
export type { ClaudeEnv } from "./paths.ts";
export { claudeConfigDir } from "./paths.ts";
export { claudeToolName, toClaudeCall } from "./tools.ts";

export interface CompatSetup {
  instructions: InstructionsResult;
  skills: SkillsResult;
  mcp: McpResult;
}

export interface LoadCompatOptions {
  cwd: string;
  dataDir: string;
  claude: ClaudeEnv;
}

/** Everything a session in `cwd` picks up from Claude Code's (and hamness's) folders. */
export function loadCompat(opts: LoadCompatOptions): CompatSetup {
  return {
    instructions: findInstructions(opts),
    skills: discoverSkills(opts),
    mcp: loadMcpServers(opts),
  };
}

export const SKILL_TOOL = "skill";

export interface CompatSessionContext {
  cwd: string;
  /** hamness's Pi config dir: the MCP log and OAuth tokens live there, never in Claude's. */
  agentDir: string;
  sessionId: () => string | undefined;
}

/** Pi extensions for a session: the `skill` tool and the MCP client for the servers that start. */
export function compatExtensions(
  setup: CompatSetup,
  ctx: CompatSessionContext,
): ExtensionFactory[] {
  const out: ExtensionFactory[] = [];
  const skills = setup.skills.skills;
  if (skills.length > 0) {
    out.push((pi) => {
      pi.registerTool({
        name: SKILL_TOOL,
        label: "Skill",
        description:
          "Load a skill's instructions by name (from the available skills list), with optional arguments.",
        parameters: Type.Object({
          name: Type.String({ description: "The skill's name" }),
          arguments: Type.Optional(Type.String({ description: "Arguments for the skill" })),
        }),
        async execute(_id, params) {
          const skill = skills.find((s) => s.name === params.name);
          const fail = (text: string) => ({
            content: [{ type: "text" as const, text }],
            details: undefined,
            isError: true,
          });
          if (!skill) {
            const names = skills.filter((s) => !s.disableModelInvocation).map((s) => s.name);
            return fail(
              `No skill named "${params.name}". Available: ${names.join(", ") || "none"}.`,
            );
          }
          if (skill.disableModelInvocation) {
            return fail(`The skill "${skill.name}" can only be run by the user.`);
          }
          const sessionId = ctx.sessionId();
          const text = renderSkill(skill, {
            projectDir: ctx.cwd,
            ...(params.arguments !== undefined ? { args: params.arguments } : {}),
            ...(sessionId ? { sessionId } : {}),
          });
          return { content: [{ type: "text" as const, text }], details: undefined };
        },
      });
    });
  }

  const servers = setup.mcp.servers.filter((s) => s.status === "start" && s.config);
  if (servers.length > 0) {
    out.push(
      createMcpExtension({
        loadConfig: () => ({
          servers: servers.flatMap((s) =>
            s.config
              ? [
                  {
                    name: s.name,
                    config: s.config,
                    source: s.source,
                    scope: s.scope === "user" ? ("global" as const) : ("project" as const),
                  },
                ]
              : [],
          ),
          autoEnableCodemode: false,
          errors: [],
        }),
        logPath: join(ctx.agentDir, "mcp.log"),
        // Pi would save `/mcp` changes to the file that defined the server: Claude Code's.
        updateConfig: () => {
          throw new Error("hamness does not change Claude Code's MCP config");
        },
        openUrl: () => {},
      }),
    );
  }
  return out;
}

/** The system prompt additions: the skills list. */
export function compatPrompt(setup: CompatSetup): string[] {
  const skills = skillsPrompt(setup.skills.skills);
  return skills ? [skills] : [];
}
