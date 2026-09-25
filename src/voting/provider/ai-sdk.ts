/**
 * Vercel AI SDK（`ai` + `@ai-sdk/*`）实现底座（ADR-0013 §关键实现注意点 15）。
 *
 * 结构约束：
 * - 平台自有 `ProviderAdapter` 接口，AI SDK 类型不泄漏出本文件；
 * - `generateText` + `Output.object`（`generateObject` 自 v6 起 deprecated）；
 * - `maxRetries: 0`——重试统一在编排层（ADR-0013 §关键实现注意点 3）；
 * - 不做任何静默降级：模型不可用/版本下线时抛错，由编排层记为该票异常。
 */
import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";

import type { ProviderAdapter, VoteRequest, VoteResponse } from "../../core/ports.js";

export class AiSdkProvider implements ProviderAdapter {
  readonly provider: string;
  private readonly model: LanguageModel;

  /** @param provider provider 标识（写入 Ballot.provider）；@param model 已构造好的模型实例。 */
  constructor(provider: string, model: LanguageModel) {
    this.provider = provider;
    this.model = model;
  }

  async complete(req: VoteRequest): Promise<VoteResponse> {
    const started_at = Date.now();
    const result = await generateText({
      model: this.model,
      system: req.system_prompt,
      prompt: req.user_prompt,
      temperature: req.temperature,
      maxRetries: 0,
      output: Output.object({
        name: "vote",
        // 结构化输出约束直接用 VoteRequest.response_schema（JSON Schema，由调用方构造）；
        // 不在此处做 zod ↔ JSON Schema 转换。
        schema: jsonSchema<unknown>(req.response_schema as JSONSchema7),
      }),
    });
    const latency_ms = Date.now() - started_at;

    return {
      // `result.output` 在无结构化输出时抛 NoOutputGeneratedError → 该票走重试/弃权路径。
      parsed_json: result.output,
      raw_text: result.text,
      usage: {
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
      },
      latency_ms,
      request_id: result.response?.id ?? null,
      // 必须记录服务端实际解析到的模型版本（可能与请求值不同，ADR-0013 §5.1）。
      served_model_id: result.response?.modelId ?? req.model_id,
    };
  }
}
