import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../../agent/models.ts";
import type { JudgeRequest, JudgeVerdict } from "../service.ts";
import {
  type BackendJudge,
  type JudgeCallOptions,
  notValid,
  parseVerdict,
  prompt,
  SYSTEM,
} from "./anthropic.ts";
import { CATEGORY_IDS } from "./categories.ts";

/** The part of Pi's runtime the judge uses. Tests pass a fake. */
export type JudgeRuntime = Pick<ModelRuntime, "getModel" | "completeSimple">;

const ANSWER = `Answer with one JSON object and nothing else: {"verdict": "allow" | "ask", "reason": "<one sentence>", "category": one of ${CATEGORY_IDS.map((c) => `"${c}"`).join(", ")}}.`;

/** The text of a reply, with a Markdown code fence around it taken off. */
function replyText(res: AssistantMessage): string | undefined {
  const text = res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return undefined;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * A judge on a ChatGPT plan model through Pi's runtime (ADR 0023): low thinking, a strict
 * verdict, $0 per call. Anything but a valid verdict asks; errors throw, and the controller
 * turns them into ask.
 */
export function createPiJudge(opts: { runtime: JudgeRuntime; model: string }): BackendJudge {
  const spec = parseModelSpec(opts.model);
  const model: Model<Api> | undefined = spec && opts.runtime.getModel(spec.provider, spec.id);
  const judge = async (req: JudgeRequest, call: JudgeCallOptions = {}): Promise<JudgeVerdict> => {
    if (!model) throw new Error(`unknown judge model ${opts.model}`);
    const context: Context = {
      systemPrompt: `${SYSTEM}\n\n${ANSWER}`,
      messages: [{ role: "user", content: prompt(req), timestamp: Date.now() }],
    };
    const res = await opts.runtime.completeSimple(model, context, {
      reasoning: "low",
      maxTokens: 2048,
      ...(call.signal ? { signal: call.signal } : {}),
    });
    const ask = (reason: string): JudgeVerdict => ({ verdict: "ask", reason, costMicros: 0 });
    if (res.stopReason === "error" || res.stopReason === "aborted") {
      throw new Error(res.errorMessage ?? `the judge model ended with ${res.stopReason}`);
    }
    if (res.stopReason === "length") return ask("the judge's answer was cut off, so it asks");
    const text = replyText(res);
    const parsed = text === undefined ? undefined : parseVerdict(text);
    if (!parsed) return ask(notValid);
    return { ...parsed, costMicros: 0 };
  };
  return Object.assign(judge, { billing: "plan" as const, model: opts.model });
}
