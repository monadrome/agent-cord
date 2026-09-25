import { describe, expect, it } from "vitest";

import type { LanguageModel } from "ai";

import { AiSdkProvider } from "../../src/voting/provider/ai-sdk.js";
import { VERDICT_RESPONSE_SCHEMA } from "../../src/voting/executor.js";

interface StubCall {
  temperature?: number;
  responseFormat?: unknown;
}

/** 最小 LanguageModelV3 桩：只为验证 generateText + Output.object 的实际接线。 */
function stubModel(behaviour: { text?: string; fail?: string }): { model: LanguageModel; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const model = {
    specificationVersion: "v3",
    provider: "stub-provider",
    modelId: "stub-model-2026-01-01",
    supportedUrls: {},
    doGenerate: async (options: StubCall) => {
      calls.push(options);
      if (behaviour.fail !== undefined) throw new Error(behaviour.fail);
      return {
        content: [{ type: "text", text: behaviour.text ?? "" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1234, noCache: 1234, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 56, text: 56, reasoning: 0 },
        },
        warnings: [],
        response: { id: "req-1", timestamp: new Date(), modelId: "stub-model-2026-01-01" },
      };
    },
  } as unknown as LanguageModel;
  return { model, calls };
}

const request = {
  model_id: "stub-model-2026-01-01",
  temperature: 0 as const,
  system_prompt: "system",
  user_prompt: "user",
  response_schema: VERDICT_RESPONSE_SCHEMA,
};

describe("AiSdkProvider", () => {
  it("用 generateText + Output.object 产出结构化结论、usage、request_id 与 served_model_id", async () => {
    const payload = {
      conclusion: "A",
      anchors: [{ kind: "code", anchor: "src/a.ts#A" }],
      confidence: 0.7,
      reason: "因为 A",
    };
    const { model, calls } = stubModel({ text: JSON.stringify(payload) });
    const provider = new AiSdkProvider("stub-provider", model);

    const response = await provider.complete(request);

    expect(provider.provider).toBe("stub-provider");
    expect(response.parsed_json).toEqual(payload);
    expect(response.raw_text).toBe(JSON.stringify(payload));
    expect(response.usage).toEqual({ input_tokens: 1234, output_tokens: 56 });
    expect(response.request_id).toBe("req-1");
    expect(response.served_model_id).toBe("stub-model-2026-01-01");
    expect(response.latency_ms).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.responseFormat).toBeDefined();
  });

  it("provider 失败时抛出且不重试（重试在编排层）", async () => {
    const { model, calls } = stubModel({ fail: "upstream 502" });
    const provider = new AiSdkProvider("stub-provider", model);

    await expect(provider.complete(request)).rejects.toThrow(/502/);
    expect(calls).toHaveLength(1);
  });

  it("模型返回非结构化文本时抛错（由 executor 记为该票异常）", async () => {
    const { model } = stubModel({ text: "这不是 JSON" });
    const provider = new AiSdkProvider("stub-provider", model);

    await expect(provider.complete(request)).rejects.toThrow();
  });
});
