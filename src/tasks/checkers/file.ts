import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckResult, EvidenceClaim } from "../types.ts";
import type { CheckContext } from "./context.ts";

type FileClaim = Extract<EvidenceClaim, { kind: "file" }>;

/**
 * Checks an artifact itself: it exists, is a non-empty file, was written during the task,
 * and gets a sha256 so later changes show. Relative paths are from the session folder.
 */
export async function checkFile(claim: FileClaim, ctx: CheckContext): Promise<CheckResult> {
  const path = resolve(ctx.cwd, claim.path);
  const base = { path: claim.path };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return {
      status: "failed",
      summary: `${claim.path} does not exist`,
      details: { ...base, exists: false },
    };
  }
  const details = { ...base, exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  if (!st.isFile()) return { status: "failed", summary: `${claim.path} is not a file`, details };
  if (st.size === 0) return { status: "failed", summary: `${claim.path} is empty`, details };
  // Whole seconds: some filesystems keep mtimes to the second only.
  const windowStart = Math.floor(ctx.taskStartedAt / 1000) * 1000;
  if (st.mtimeMs < windowStart) {
    return {
      status: "failed",
      summary: `${claim.path} was last written before the task started`,
      details: { ...details, taskStartedAt: ctx.taskStartedAt },
    };
  }
  let sha256: string;
  try {
    sha256 = await hashFile(path);
  } catch (err) {
    return {
      status: "error",
      summary: `could not read ${claim.path}: ${(err as Error).message}`,
      details,
    };
  }
  // ADR 0019: a file the agent wrote with its own write / edit tools is weak evidence.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  const weak = ctx.writtenByAgent?.(real) === true || ctx.writtenByAgent?.(path) === true;
  return {
    status: "passed",
    summary: `${claim.path}: ${st.size} bytes, sha256 ${sha256.slice(0, 12)}${
      weak ? " (weak: the agent wrote it itself, so it does not verify alone)" : ""
    }`,
    details: { ...details, sha256, ...(weak ? { weak: true } : {}) },
  };
}

function hashFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}
