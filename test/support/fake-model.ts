import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelChoice } from "../../src/agent/models.ts";
import type { TokenUsage } from "../../src/agent/pricing.ts";

/** One scripted model reply: text, optional tool calls, and the usage it reports. */
export interface FakeReply {
  text?: string;
  tools?: Array<{ name: string; args: Record<string, unknown> }>;
  usage?: TokenUsage;
}

export interface FakeModel extends ModelChoice {
  /** Queue replies; each model call takes the next one. */
  script(replies: FakeReply[]): void;
  readonly calls: number;
}

const DEFAULT_USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

/**
 * A model provider with no network: Pi's faux provider, with fixed usage per reply
 * (the faux provider estimates usage itself, which tests can't pin down).
 * The model id is a real Claude id so the price table applies.
 */
export async function fakeModel(dir: string, modelId = "claude-opus-5-5"): Promise<FakeModel> {
  const core = createFauxCore({ provider: "fake", models: [{ id: modelId }] });
  const usages: TokenUsage[] = [];

  const fixUsage =
    (fn: typeof core.stream) =>
    (...args: Parameters<typeof core.stream>): AssistantMessageEventStream => {
      const usage = usages.shift() ?? DEFAULT_USAGE;
      const inner = fn(...args);
      const out = createAssistantMessageEventStream();
      void (async () => {
        for await (const ev of inner) {
          if (ev.type === "done") {
            ev.message.usage = {
              ...usage,
              totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
          }
          out.push(ev);
        }
        out.end();
      })();
      return out;
    };

  const provider = createProvider({
    id: "fake",
    name: "Fake",
    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: { stream: fixUsage(core.stream), streamSimple: fixUsage(core.streamSimple) },
  } as unknown as Parameters<typeof createProvider>[0]);

  const runtime = await ModelRuntime.create({
    authPath: join(dir, "fake-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider);
  const model = runtime.getModel("fake", modelId);
  if (!model) throw new Error("fake model did not register");

  return {
    runtime,
    model,
    get calls() {
      return core.state.callCount;
    },
    script(replies) {
      core.appendResponses(
        replies.map((r) => {
          usages.push(r.usage ?? DEFAULT_USAGE);
          const blocks = [
            ...(r.text ? [fauxText(r.text)] : []),
            ...(r.tools ?? []).map((t) =>
              fauxToolCall(t.name, t.args as Parameters<typeof fauxToolCall>[1]),
            ),
          ];
          return fauxAssistantMessage(blocks, { stopReason: r.tools?.length ? "toolUse" : "stop" });
        }),
      );
    },
  };
}
