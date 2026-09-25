/**
 * 投票执行器（盲评）——ADR-0013 / ADR-0006 / docs/05。
 *
 * 职责边界：
 * - 编排层预组装每票的净输入（system + user prompt 都只包含该票可见的信息）；
 * - 每票一次独立、互不可见的 adapter 调用（temperature=0，per-agent 选项随机置换）；
 * - 锚点机验、失败重试 1 次、判定与统计、少数派留痕；
 * - 判定侧直连模型 API（ADR-0013），不做任何其他副作用（写账本/写事件流由调用方负责）。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ANCHOR_OVERLAP_THRESHOLD,
  AnchorSchema,
  VoteRecordSchema,
  type Anchor,
  type Ballot,
  type VoteRecord,
  type VoteVerdict,
} from "../core/schema.js";
import type { VoteExecutor, VoteExecutorInput, VoteRequest, VoteResponse } from "../core/ports.js";
import { anchorOverlap } from "./jaccard.js";

/** 固定兜底项（docs/05 §3.2）：证据不足时不许强行二选一。 */
export const ABSTAIN_OPTION = "insufficient_evidence";

/**
 * 一次判定的输出契约。`conclusion` 必须逐字符落在选项集内（含兜底项），
 * 否则视为解析失败 → 重试 1 次 → 该票弃权。
 */
export const VerdictPayloadSchema = z.object({
  conclusion: z.string().min(1),
  anchors: z.array(AnchorSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().default(""),
});
export type VerdictPayload = z.infer<typeof VerdictPayloadSchema>;

/** 交给适配器的结构化输出约束（JSON Schema，draft-07）。 */
export const VERDICT_RESPONSE_SCHEMA = z.toJSONSchema(VerdictPayloadSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

export type BallotStatus =
  | "ok"
  | "abstain_insufficient_evidence"
  | "abstain_no_verifiable_anchor"
  | "abstain_provider_error"
  | "abstain_invalid_output";

/**
 * 逐票审计记录。VoteRecord（schema.ts）里没有位置的字段落在这里：
 * 被剔除的不可机验锚点、served_model_id、latency、模型给出的 reason、失败原因。
 * 调用方应把它落到 `votes/` 留痕（ADR-0006 §关键实现注意点 8）。
 */
export interface BallotAudit {
  agent_id: string;
  provider: string;
  /** 请求的模型 id（带版本后缀）；实际服务版本见 served_model_id。 */
  requested_model_id: string;
  served_model_id: string | null;
  status: BallotStatus;
  attempts: number;
  error: string | null;
  /** 模型给出的理由原文（Ballot 无该字段；2:1 时用于填 minority.reason）。 */
  reason: string | null;
  /** 模型给出的原始结论（可能已被归一化为兜底项，或被判为选项外作答）。 */
  conclusion: string | null;
  /** 通过机验、保留在该票上的锚点。 */
  kept_anchors: Anchor[];
  /** 未通过机验（或机验器抛错）而被剔除的锚点。 */
  dropped_anchors: Anchor[];
  latency_ms: number | null;
  request_id: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  response_hash: string | null;
  option_permutation: number[];
}

export interface VoteExecutorOptions {
  /** 可注入 RNG（默认 Math.random）；置换的全部随机性都来自它，便于复现。 */
  rng?: () => number;
  /** 单票最大尝试次数，默认 2（= 失败重试 1 次，ADR-0013 §5.1）。 */
  max_attempts?: number;
  /** 显式指定 vote_id；缺省按执行器实例内的单调序号生成 `V-n`。 */
  vote_id?: string;
  /** 逐票审计回调（剔除的锚点、served_model_id 等）。 */
  on_ballot_audit?: (audit: BallotAudit) => void;
}

export function createVoteExecutor(options: VoteExecutorOptions = {}): VoteExecutor {
  const rng = options.rng ?? Math.random;
  const max_attempts = options.max_attempts ?? 2;
  let vote_seq = 0;

  return {
    async run(input: VoteExecutorInput): Promise<VoteRecord> {
      const voters = input.voters;
      if (voters.length < 2 || voters.length > 3) {
        throw new Error(`voting: voter count must be 2..3 (k=2..3), got ${voters.length}`);
      }

      const option_list = canonicalOptions(input.decision_point.options);
      const runs: VoterRun[] = [];

      // 顺序执行：置换在构造 prompt 前一次性算定，票与票之间不共享任何中间结果。
      for (const voter of voters) {
        const permutation = shuffledPermutation(option_list.length, rng);
        const run = await runVoter({
          voter,
          permutation,
          decision_point: input.decision_point,
          option_list,
          verify_anchor: input.verify_anchor,
          max_attempts,
        });
        runs.push(run);
        options.on_ballot_audit?.(run.audit);
      }

      const record = judge({
        vote_id: options.vote_id ?? `V-${(vote_seq += 1)}`,
        decision_point: input.decision_point,
        option_list,
        runs,
      });
      return VoteRecordSchema.parse(record);
    },
  };
}

// ---------------------------------------------------------------------------
// 单票
// ---------------------------------------------------------------------------

interface VoterRun {
  ballot: Ballot;
  audit: BallotAudit;
  /** 该票是否按弃权处理（失败、兜底项、锚点被清空）。 */
  abstained: boolean;
}

interface RunVoterArgs {
  voter: VoteExecutorInput["voters"][number];
  /** 位置序的规范索引置换：`permutation[position]` = 该位置展示的规范选项下标。 */
  permutation: number[];
  decision_point: VoteExecutorInput["decision_point"];
  option_list: string[];
  verify_anchor: (anchor: Anchor) => Promise<boolean>;
  max_attempts: number;
}

async function runVoter(args: RunVoterArgs): Promise<VoterRun> {
  const { voter, permutation, decision_point, option_list, verify_anchor, max_attempts } = args;
  const system_prompt = buildSystemPrompt(option_list, permutation);
  const user_prompt = buildUserPrompt(decision_point);
  const prompt_hash = hashPrompt(system_prompt, user_prompt);

  const request: VoteRequest = {
    model_id: voter.model_id,
    temperature: 0,
    system_prompt,
    user_prompt,
    response_schema: VERDICT_RESPONSE_SCHEMA,
  };

  let last_response: VoteResponse | null = null;
  let payload: VerdictPayload | null = null;
  let error: string | null = null;
  let attempts = 0;

  while (attempts < max_attempts && payload === null) {
    attempts += 1;
    try {
      const response = await voter.adapter.complete(request);
      last_response = response;
      const parsed = VerdictPayloadSchema.safeParse(response.parsed_json);
      if (!parsed.success) {
        error = `invalid structured output: ${describeZodError(parsed.error)}`;
        continue;
      }
      if (!option_list.includes(parsed.data.conclusion)) {
        error = `conclusion outside option set: ${JSON.stringify(parsed.data.conclusion)}`;
        continue;
      }
      payload = parsed.data;
      error = null;
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  // 锚点机验：不可机验的锚点逐个剔除并记录（机验器抛错按不可机验处理）。
  const kept_anchors: Anchor[] = [];
  const dropped_anchors: Anchor[] = [];
  if (payload !== null) {
    for (const anchor of payload.anchors) {
      let verified = false;
      try {
        verified = await verify_anchor(anchor);
      } catch {
        verified = false;
      }
      if (verified) kept_anchors.push(anchor);
      else dropped_anchors.push(anchor);
    }
  }

  const outcome = classify({ payload, last_response, kept_anchors });

  const ballot: Ballot = {
    agent_id: voter.agent_id,
    provider: voter.adapter.provider,
    // 记录服务端实际解析到的版本（拿不到时回落到请求的 model_id）——不得静默降级。
    model_id: last_response?.served_model_id ?? voter.model_id,
    prompt_hash,
    option_permutation: permutation,
    conclusion: outcome.conclusion,
    anchors: outcome.anchors,
    confidence: outcome.confidence,
    usage: last_response?.usage ?? null,
    request_id: last_response?.request_id ?? null,
    response_hash: last_response === null ? null : sha256Hex(last_response.raw_text),
  };

  const audit: BallotAudit = {
    agent_id: voter.agent_id,
    provider: voter.adapter.provider,
    requested_model_id: voter.model_id,
    served_model_id: last_response?.served_model_id ?? null,
    status: outcome.status,
    attempts,
    error,
    reason: payload?.reason ?? null,
    conclusion: payload?.conclusion ?? null,
    kept_anchors,
    dropped_anchors,
    latency_ms: last_response?.latency_ms ?? null,
    request_id: last_response?.request_id ?? null,
    usage: last_response?.usage ?? null,
    response_hash: ballot.response_hash ?? null,
    option_permutation: permutation,
  };

  return { ballot, audit, abstained: outcome.status !== "ok" };
}

interface Outcome {
  status: BallotStatus;
  conclusion: string;
  anchors: Anchor[];
  confidence: number;
}

function classify(args: {
  payload: VerdictPayload | null;
  last_response: VoteResponse | null;
  kept_anchors: Anchor[];
}): Outcome {
  const { payload, last_response, kept_anchors } = args;

  if (payload === null) {
    // 两次尝试都失败（或结论落在选项集之外）→ 记弃权，等价于投兜底项，不阻塞整体。
    return {
      status: last_response === null ? "abstain_provider_error" : "abstain_invalid_output",
      conclusion: ABSTAIN_OPTION,
      anchors: [],
      confidence: 0,
    };
  }

  if (payload.conclusion === ABSTAIN_OPTION) {
    return {
      status: "abstain_insufficient_evidence",
      conclusion: ABSTAIN_OPTION,
      anchors: kept_anchors,
      confidence: payload.confidence,
    };
  }

  if (kept_anchors.length === 0) {
    // 「给不出锚点就必须选兜底项」（docs/05 §3.2）：机验后锚点清空的实质结论按弃权处理。
    return {
      status: "abstain_no_verifiable_anchor",
      conclusion: ABSTAIN_OPTION,
      anchors: [],
      confidence: 0,
    };
  }

  return {
    status: "ok",
    conclusion: payload.conclusion,
    anchors: kept_anchors,
    confidence: payload.confidence,
  };
}

// ---------------------------------------------------------------------------
// 判定与统计
// ---------------------------------------------------------------------------

function judge(args: {
  vote_id: string;
  decision_point: VoteExecutorInput["decision_point"];
  option_list: string[];
  runs: VoterRun[];
}): VoteRecord {
  const { vote_id, decision_point, option_list, runs } = args;
  const valid = runs.filter((run) => !run.abstained);

  const tally = new Map<string, number>();
  for (const run of valid) {
    const conclusion = run.ballot.conclusion;
    tally.set(conclusion, (tally.get(conclusion) ?? 0) + 1);
  }

  let majority_conclusion: string | null = null;
  let majority_count = 0;
  for (const [conclusion, count] of [...tally.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > majority_count) {
      majority_conclusion = conclusion;
      majority_count = count;
    }
  }

  let verdict: VoteVerdict;
  let minority: VoteRecord["minority"] = null;

  if (valid.length < 2) {
    // 有效票不足 2（含全票弃权）→ 不下判定，转人工补事实与上下文。
    verdict = "abstain";
  } else if (majority_count === valid.length) {
    if (!decision_point.machine_verifiable) {
      // 语义类即使全票一致也永不免审（ADR-0006 §3.3）。
      verdict = "needs_verification";
    } else if (valid.some((run) => run.ballot.anchors.length === 0)) {
      verdict = "needs_verification";
    } else if (hasAnchorOverlap(valid)) {
      // 一致 + 锚点重合 = 疑似同源错误，优先级高于 confirmed。
      verdict = "escalated_anchor_overlap";
    } else {
      verdict = "confirmed";
    }
  } else {
    verdict = "needs_verification";
    if (valid.length === 3 && majority_count === 2 && majority_conclusion !== null) {
      const dissenter = valid.find((run) => run.ballot.conclusion !== majority_conclusion);
      if (dissenter !== undefined) {
        minority = {
          conclusion: dissenter.ballot.conclusion,
          reason: dissenter.audit.reason ?? "",
          anchors: dissenter.ballot.anchors,
        };
      }
    }
  }

  return {
    vote_id,
    decision_point: {
      id: decision_point.id,
      options: option_list,
      machine_verifiable: decision_point.machine_verifiable,
    },
    k: runs.length,
    ballots: runs.map((run) => run.ballot),
    stats: {
      raw_agreement: valid.length === 0 ? 0 : majority_count / valid.length,
      anchor_overlap: maxPairwiseJaccard(valid),
    },
    verdict,
    minority,
  };
}

/** 结论一致 + 任两票重合（Jaccard ≥ 阈值 或 一方为另一方子集）→ 独立度不足。 */
function hasAnchorOverlap(valid: VoterRun[]): boolean {
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const left = valid[i];
      const right = valid[j];
      if (left === undefined || right === undefined) continue;
      const { jaccard, subset } = anchorOverlap(left.ballot.anchors, right.ballot.anchors);
      if (jaccard >= ANCHOR_OVERLAP_THRESHOLD || subset) return true;
    }
  }
  return false;
}

function maxPairwiseJaccard(valid: VoterRun[]): number {
  let max = 0;
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const left = valid[i];
      const right = valid[j];
      if (left === undefined || right === undefined) continue;
      const { jaccard } = anchorOverlap(left.ballot.anchors, right.ballot.anchors);
      if (jaccard > max) max = jaccard;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// 净输入构造（盲评：每票只看得到自己这一份）
// ---------------------------------------------------------------------------

/** 选项集 + 固定兜底项（已含则不再追加）。 */
export function canonicalOptions(options: readonly string[]): string[] {
  const list = [...options];
  if (!list.includes(ABSTAIN_OPTION)) list.push(ABSTAIN_OPTION);
  return list;
}

export function buildSystemPrompt(option_list: readonly string[], permutation: readonly number[]): string {
  const shown = permutation.map((canonical_index) => option_list[canonical_index] ?? "");
  return [
    "你是本次决策点的独立评审员，只投这一票。",
    "盲评纪律（硬约束）：",
    "- 你与其他评审员互相隔离：看不到任何人的结论、理由与证据，也不得引用他人意见或投票结果。",
    "- 结论只能来自你自己对只读快照与上下文包的独立取证。",
    "",
    "可选结论（只能原样选择其中一个，禁止在选项集之外作答）：",
    ...shown.map((option) => `- ${option}`),
    "",
    `兜底项 ${ABSTAIN_OPTION}：证据不足以支撑任何实质结论时必须选它，不许强行二选一。`,
    "每票必须给出至少一条真实存在的证据锚点；给不出锚点就必须选兜底项。",
    "",
    "输出契约（严格 JSON，不要输出任何其他内容）：",
    "{",
    '  "conclusion": "<上面某个选项的原文，逐字符一致>",',
    '  "anchors": [{"kind": "code|test|contract|knowledge|doc", "anchor": "<规范化符号锚点，如 src/x.ts#Symbol.method 或 tests/x.test.ts#case-id>"}],',
    '  "confidence": <0 到 1 之间的数>,',
    '  "reason": "<一句话理由>"',
    "}",
  ].join("\n");
}

export function buildUserPrompt(decision_point: VoteExecutorInput["decision_point"]): string {
  return [
    `决策点：${decision_point.id}`,
    `问题：${decision_point.question}`,
    "",
    "上下文包（只读；自行取证，不得引用他人结论）：",
    decision_point.context_pack,
    "",
    "请按输出契约返回 JSON：conclusion 必须是上面某个选项的原文。",
  ].join("\n");
}

/** prompt_hash = sha256(system + user prompt)，供审计与反查（不回放模型输出）。 */
export function hashPrompt(system_prompt: string, user_prompt: string): string {
  return sha256Hex(`${system_prompt}\n\n${user_prompt}`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** Fisher-Yates；`permutation[position]` = 该位置展示的规范选项下标。 */
function shuffledPermutation(size: number, rng: () => number): number[] {
  const permutation = Array.from({ length: size }, (_, index) => index);
  for (let i = size - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const left = permutation[i];
    const right = permutation[j];
    if (left === undefined || right === undefined) continue;
    permutation[i] = right;
    permutation[j] = left;
  }
  return permutation;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
