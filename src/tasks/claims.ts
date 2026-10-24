import { Type } from "typebox";
import { proofCommandProblem } from "./proof-shape.ts";
import type { EvidenceClaim } from "./types.ts";

/** Longest a command re-run may take (30 minutes) and a URL fetch (2 minutes). */
export const MAX_COMMAND_TIMEOUT_S = 1800;
export const MAX_URL_TIMEOUT_S = 120;

const FIELDS: Record<EvidenceClaim["kind"], readonly string[]> = {
  command: ["command", "timeoutSeconds"],
  file: ["path"],
  url: ["url", "timeoutSeconds"],
  ci: ["pr", "commit", "repo"],
};

/** Keys that would state a result. Named in the error so the agent learns why. */
const RESULT_KEYS = /^(status|passed|pass|ok|result|results|verified|exit_?code|outcome)$/i;

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const PR_NUMBER = /^\d+$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * The `prove` tool's parameters. Flat (one object, not a union) so every provider accepts it;
 * `parseClaim` checks the per-kind rules. No property can carry a result.
 */
export const PROVE_PARAMETERS = Type.Object(
  {
    kind: Type.Union(
      [Type.Literal("command"), Type.Literal("file"), Type.Literal("url"), Type.Literal("ci")],
      { description: "What hamness should check." },
    ),
    command: Type.Optional(
      Type.String({
        description: "command: hamness re-runs it in the session folder; exit 0 passes.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "command or url: how long hamness waits (default 300 / 15)." }),
    ),
    path: Type.Optional(
      Type.String({
        description: "file: must exist, be non-empty and be written during the task.",
      }),
    ),
    url: Type.Optional(Type.String({ description: "url: hamness fetches it; a 2xx passes." })),
    pr: Type.Optional(
      Type.String({ description: "ci: a PR number or URL; every check must pass." }),
    ),
    commit: Type.Optional(Type.String({ description: "ci: a commit sha; every check must pass." })),
    repo: Type.Optional(
      Type.String({ description: "ci: owner/name, when not the session's repo." }),
    ),
  },
  { additionalProperties: false },
);

export type ParsedClaim = { ok: true; claim: EvidenceClaim } | { ok: false; error: string };

const fail = (error: string): ParsedClaim => ({ ok: false, error });

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function timeout(v: unknown, max: number): number | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) return null;
  return v;
}

/** Validates what an agent passed to `prove`. Strict: any field it doesn't expect is refused. */
export function parseClaim(input: unknown): ParsedClaim {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("evidence must be an object with a kind");
  }
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "command" && kind !== "file" && kind !== "url" && kind !== "ci") {
    return fail("kind must be command, file, url or ci");
  }
  const present = Object.keys(raw).filter((k) => k !== "kind" && raw[k] !== undefined);
  const stated = present.find((k) => RESULT_KEYS.test(k));
  if (stated) {
    return fail(
      `"${stated}" is not allowed: only hamness's checker decides whether evidence passed`,
    );
  }
  const extra = present.find((k) => !FIELDS[kind].includes(k));
  if (extra) return fail(`"${extra}" is not a field of ${kind} evidence`);

  switch (kind) {
    case "command": {
      if (!nonEmpty(raw.command)) return fail("command evidence needs a command");
      const problem = proofCommandProblem(raw.command);
      if (problem) return fail(`not proof: ${problem}`);
      const t = timeout(raw.timeoutSeconds, MAX_COMMAND_TIMEOUT_S);
      if (t === null) return fail(`timeoutSeconds must be between 0 and ${MAX_COMMAND_TIMEOUT_S}`);
      return {
        ok: true,
        claim: { kind, command: raw.command, ...(t ? { timeoutSeconds: t } : {}) },
      };
    }
    case "file":
      if (!nonEmpty(raw.path)) return fail("file evidence needs a path");
      return { ok: true, claim: { kind, path: raw.path } };
    case "url": {
      if (!nonEmpty(raw.url)) return fail("url evidence needs a url");
      let parsed: URL;
      try {
        parsed = new URL(raw.url);
      } catch {
        return fail("url is not a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail("url must be http or https");
      }
      const t = timeout(raw.timeoutSeconds, MAX_URL_TIMEOUT_S);
      if (t === null) return fail(`timeoutSeconds must be between 0 and ${MAX_URL_TIMEOUT_S}`);
      return { ok: true, claim: { kind, url: raw.url, ...(t ? { timeoutSeconds: t } : {}) } };
    }
    case "ci": {
      const pr = typeof raw.pr === "number" ? String(raw.pr) : raw.pr;
      const { commit, repo } = raw;
      if ((pr === undefined) === (commit === undefined)) {
        return fail("ci evidence needs exactly one of pr or commit");
      }
      if (
        pr !== undefined &&
        !(typeof pr === "string" && (PR_NUMBER.test(pr) || PR_URL.test(pr)))
      ) {
        return fail("pr must be a PR number or a github.com pull URL");
      }
      if (commit !== undefined && !(typeof commit === "string" && SHA.test(commit))) {
        return fail("commit must be a 7 to 40 character hex sha");
      }
      if (repo !== undefined && !(typeof repo === "string" && REPO.test(repo))) {
        return fail("repo must be owner/name");
      }
      return {
        ok: true,
        claim: {
          kind,
          ...(pr !== undefined ? { pr } : {}),
          ...(commit !== undefined ? { commit: commit as string } : {}),
          ...(repo !== undefined ? { repo: repo as string } : {}),
        },
      };
    }
  }
}
