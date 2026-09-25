/**
 * 脚本化的 ProviderAdapter（测试与回放实验用）。
 *
 * 只依赖 ports.ts 的 `VoteRequest` / `VoteResponse`，不引入任何 provider SDK；
 * 响应可按 `model_id` 或按调用序编排，并可注入失败（用于验证重试与 abstain 路径）。
 */
import type { ProviderAdapter, VoteRequest, VoteResponse } from "../../core/ports.js";

export interface MockUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface MockOkSpec {
  /** 结构化输出；缺省为 undefined（模拟「解析不出结构化输出」的失败形态）。 */
  parsed_json?: unknown;
  /** 原始文本；缺省由 parsed_json 序列化而来。 */
  raw_text?: string;
  usage?: MockUsage | null;
  request_id?: string | null;
  latency_ms?: number;
  /** 服务端实际解析到的模型版本；缺省等于请求的 model_id。 */
  served_model_id?: string;
}

/** 一次脚本化响应：ok 返回结构化结果；fail 抛出错误。 */
export type MockStep = ({ ok: true } & MockOkSpec) | { ok: false; error: string };

/** 构造便捷函数：一条成功响应。 */
export function mockReply(parsed_json: unknown, extra: Omit<MockOkSpec, "parsed_json"> = {}): MockStep {
  return { ok: true, parsed_json, ...extra };
}

/** 构造便捷函数：一条失败响应（计入该票的重试/弃权路径，不会产生 VoteResponse）。 */
export function mockFailure(error = "mock provider failure"): MockStep {
  return { ok: false, error };
}

export interface MockProviderOptions {
  /** ProviderAdapter.provider 的取值（须跨 provider 异构，见 ADR-0007）。 */
  provider?: string;
  /** 按 model_id 的独立脚本队列（各自按该 model 的调用序消耗）。 */
  by_model_id?: Record<string, MockStep[]>;
  /** 全局调用序脚本（按构造后收到的调用顺序消耗）。 */
  sequence?: MockStep[];
  /** `sequence` 的简写形态：按调用序的响应表（每条都视为成功响应）。 */
  responses?: Array<{ parsed_json: unknown; raw_text?: string }>;
  /** 未匹配到任何脚本时的兜底响应；缺省则抛错（暴露漏写的脚本）。 */
  fallback?: MockStep;
}

/**
 * 注意：脚本数组按「消费位点」推进——`by_model_id` 的每个队列各有一个位点，
 * `sequence`（含 `responses` 简写，等价于逐条 {ok:true}）有自己独立的位点；
 * 耗尽后落到 `fallback`，无 fallback 则抛错。
 */
export class MockProvider implements ProviderAdapter {
  readonly provider: string;
  /** 收到过的全部请求（按调用序，供断言与回放）。 */
  readonly requests: VoteRequest[] = [];

  private readonly by_model_id: Map<string, MockStep[]>;
  private readonly sequence: MockStep[];
  private readonly fallback: MockStep | null;
  private readonly cursors = new Map<string, number>();
  private sequence_cursor = 0;

  constructor(options: MockProviderOptions | MockStep[] = {}) {
    const opts: MockProviderOptions = Array.isArray(options) ? { sequence: options } : options;
    this.provider = opts.provider ?? "mock";
    this.by_model_id = new Map(
      Object.entries(opts.by_model_id ?? {}).map(([model_id, steps]) => [model_id, [...steps]]),
    );
    this.sequence = [
      ...(opts.sequence ?? []),
      ...(opts.responses ?? []).map((response): MockStep => ({ ok: true, ...response })),
    ];
    this.fallback = opts.fallback ?? null;
  }

  /** 已发生的调用次数（含失败）。 */
  get calls(): number {
    return this.requests.length;
  }

  async complete(req: VoteRequest): Promise<VoteResponse> {
    this.requests.push(req);
    const call_index = this.requests.length;
    const step = this.next_step(req.model_id);

    if (!step.ok) throw new Error(step.error);

    const raw_text =
      step.raw_text ?? (step.parsed_json === undefined ? "" : JSON.stringify(step.parsed_json));
    return {
      parsed_json: step.parsed_json,
      raw_text,
      usage: step.usage ?? null,
      latency_ms: step.latency_ms ?? 0,
      request_id: step.request_id ?? `mock-request-${call_index}`,
      served_model_id: step.served_model_id ?? req.model_id,
    };
  }

  private next_step(model_id: string): MockStep {
    const scripted = this.by_model_id.get(model_id);
    if (scripted) {
      const cursor = this.cursors.get(model_id) ?? 0;
      const step = scripted[cursor];
      if (step) {
        this.cursors.set(model_id, cursor + 1);
        return step;
      }
    }

    const sequenced = this.sequence[this.sequence_cursor];
    if (sequenced) {
      this.sequence_cursor += 1;
      return sequenced;
    }

    if (this.fallback) return this.fallback;
    throw new Error(`MockProvider: no scripted response for model_id="${model_id}" (call #${this.requests.length})`);
  }
}
