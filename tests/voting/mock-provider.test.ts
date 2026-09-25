import { describe, expect, it } from "vitest";

import type { VoteRequest } from "../../src/core/ports.js";
import { MockProvider, mockFailure, mockReply } from "../../src/voting/provider/mock.js";

function request(model_id: string): VoteRequest {
  return {
    model_id,
    temperature: 0,
    system_prompt: "system",
    user_prompt: "user",
    response_schema: { type: "object" },
  };
}

const payload = { conclusion: "A", anchors: [], confidence: 1, reason: "r" };

describe("MockProvider", () => {
  it("按 model_id 分派脚本（各队列独立推进）", async () => {
    const provider = new MockProvider({
      provider: "provider-a",
      by_model_id: {
        "m-1": [mockReply({ conclusion: "A" }, { request_id: "r-1" }), mockReply({ conclusion: "B" })],
        "m-2": [mockReply({ conclusion: "C" })],
      },
    });

    const first = await provider.complete(request("m-1"));
    const second = await provider.complete(request("m-1"));
    const third = await provider.complete(request("m-2"));

    expect(provider.provider).toBe("provider-a");
    expect(first.parsed_json).toEqual({ conclusion: "A" });
    expect(first.request_id).toBe("r-1");
    expect(second.parsed_json).toEqual({ conclusion: "B" });
    expect(third.parsed_json).toEqual({ conclusion: "C" });
    expect(provider.calls).toBe(3);
    expect(provider.requests.map((r) => r.model_id)).toEqual(["m-1", "m-1", "m-2"]);
  });

  it("按调用序编排（sequence）并支持数组简写", async () => {
    const provider = new MockProvider([mockReply({ conclusion: "x" }), mockFailure("boom")]);

    expect((await provider.complete(request("m-1"))).parsed_json).toEqual({ conclusion: "x" });
    await expect(provider.complete(request("m-1"))).rejects.toThrow("boom");
  });

  it("默认值：raw_text 由 parsed_json 序列化、served_model_id 等于请求模型、latency 0", async () => {
    const provider = new MockProvider({ sequence: [mockReply(payload)] });
    const response = await provider.complete(request("m-versioned-2026-01-01"));

    expect(response.raw_text).toBe(JSON.stringify(payload));
    expect(response.served_model_id).toBe("m-versioned-2026-01-01");
    expect(response.latency_ms).toBe(0);
    expect(response.usage).toBeNull();
    expect(response.request_id).toBe("mock-request-1");
  });

  it("脚本耗尽且无 fallback 时抛错（漏写脚本要暴露，不静默兜底）", async () => {
    const provider = new MockProvider({ sequence: [mockReply(payload)] });
    await provider.complete(request("m-1"));
    await expect(provider.complete(request("m-1"))).rejects.toThrow(/no scripted response for model_id="m-1"/);
  });

  it("fallback 可承接所有未编排的调用", async () => {
    const provider = new MockProvider({ fallback: mockReply(payload, { served_model_id: "resolved-1" }) });
    const response = await provider.complete(request("m-x"));
    expect(response.served_model_id).toBe("resolved-1");
    expect(response.parsed_json).toEqual(payload);
  });

  it("raw_text 可独立注入（模拟解析不出结构化输出）", async () => {
    const provider = new MockProvider({ sequence: [mockReply(undefined, { raw_text: "not json" })] });
    const response = await provider.complete(request("m-1"));
    expect(response.parsed_json).toBeUndefined();
    expect(response.raw_text).toBe("not json");
  });

  it("responses 简写等价于按调用序的成功响应表（供上层薄编排使用）", async () => {
    const provider = new MockProvider({
      provider: "mock-a",
      responses: [{ parsed_json: { conclusion: "confirm" }, raw_text: "{}" }],
    });

    const response = await provider.complete(request("mock-a-v1"));
    expect(provider.provider).toBe("mock-a");
    expect(response.parsed_json).toEqual({ conclusion: "confirm" });
    expect(response.raw_text).toBe("{}");
  });
});
