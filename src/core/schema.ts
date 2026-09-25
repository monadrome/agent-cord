/**
 * agent-cord 模块间契约（唯一权威）。
 * 依据：ADR-0010 / ADR-0012 / ADR-0013 / ADR-0014 / ADR-0020、docs/04、docs/05、docs/06。
 * 所有模块的跨边界数据结构以此文件为准；修改须经 ADR。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  id: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

/** 证据锚点三层结构：符号锚点（活，参与判定）+ SHA/hash（存档）+ 行号（仅显示层）。 */
export const AnchorSchema = z.object({
  kind: z.enum(["code", "test", "contract", "knowledge", "doc"]),
  /** 规范化符号锚点，如 "src/gate/trigger-registry.ts#TriggerRegistry.resolve" 或 "tests/x.test.ts#case-id" */
  anchor: z.string().min(1),
  snapshot: z
    .object({
      commit: z.string().optional(),
      lines: z.string().optional(),
      content_hash: z.string().optional(),
    })
    .optional(),
  /** 仅显示层，不参与判定 */
  line_hint: z.string().optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

// ---------------------------------------------------------------------------
// 事件流（ADR-0020）
// ---------------------------------------------------------------------------

export const EventEnvelopeSchema = z.object({
  /** ULID，全局唯一，禁止内容哈希派生 */
  event_id: z.string().regex(ULID_RE),
  session_id: z.string().min(1),
  /** 会话内、单写者血统内单调序号，由 daemon 追加时分配 */
  seq: z.number().int().positive(),
  /** 同会话前一事件内容哈希；首事件为 null */
  prev_event_hash: z.string().nullable(),
  /** 点分层命名，如 ledger.entry.proposed / vote.completed / gate.passed */
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  schema_version: z.literal("1"),
  timestamp: z.string().datetime({ offset: true }),
  actor: ActorSchema,
  correlation_id: z.string().nullable(),
  payload: z.unknown(),
  source: z.object({ adapter: z.string().min(1) }),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** append_event 的输入：seq / prev_event_hash / timestamp 由写者分配 */
export const EventDraftSchema = EventEnvelopeSchema.omit({
  seq: true,
  prev_event_hash: true,
  timestamp: true,
});
export type EventDraft = z.infer<typeof EventDraftSchema>;

// ---------------------------------------------------------------------------
// 共识账本（docs/04）
// ---------------------------------------------------------------------------

export const LedgerStatusSchema = z.enum(["provisional", "confirmed", "overturned"]);
export type LedgerStatus = z.infer<typeof LedgerStatusSchema>;

export const LedgerEntrySchema = z.object({
  entry_id: z.string().regex(/^C-\d+$/),
  title: z.string().min(1),
  status: LedgerStatusSchema,
  anchors: z.array(AnchorSchema).min(1),
  confidence_source: z.enum(["vote_agreement", "human_confirmation", "evidence_direct"]),
  vote_record_id: z.string().nullable().default(null),
  superseded_by: z.string().nullable().default(null),
  overturn_reason: z.string().nullable().default(null),
  /** reducer 并发冲突标记：reducer 不静默择胜（ADR-0020 决策 5） */
  conflict: z.boolean().default(false),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerSchema = z.object({
  /** 由 reducer 写入：输入事件流哈希 / 输出哈希 / reducer 版本（ADR-0020 决策 4） */
  reducer_version: z.string(),
  input_hash: z.string(),
  output_hash: z.string(),
  entries: z.array(LedgerEntrySchema),
});
export type Ledger = z.infer<typeof LedgerSchema>;

// ---------------------------------------------------------------------------
// 投票（ADR-0013 / docs/05）
// ---------------------------------------------------------------------------

export const BallotSchema = z.object({
  agent_id: z.string().min(1),
  provider: z.string().min(1),
  /** 必须带版本后缀的实际模型 id */
  model_id: z.string().min(1),
  prompt_hash: z.string().min(1),
  /** per-agent 选项随机置换（防位置偏置） */
  option_permutation: z.array(z.number().int()),
  conclusion: z.string().min(1),
  anchors: z.array(AnchorSchema).default([]),
  confidence: z.number().min(0).max(1),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .nullable()
    .default(null),
  request_id: z.string().nullable().default(null),
  /** 输出原文 hash（temperature=0 不保证确定性，留档供反查） */
  response_hash: z.string().nullable().default(null),
});
export type Ballot = z.infer<typeof BallotSchema>;

export const VoteVerdictSchema = z.enum([
  "confirmed",
  "needs_verification",
  "escalated_anchor_overlap",
  "abstain",
]);
export type VoteVerdict = z.infer<typeof VoteVerdictSchema>;

export const VoteRecordSchema = z.object({
  vote_id: z.string().regex(/^V-\d+$/),
  decision_point: z.object({
    id: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    machine_verifiable: z.boolean(),
  }),
  k: z.number().int().min(2).max(3),
  ballots: z.array(BallotSchema),
  stats: z.object({
    raw_agreement: z.number().min(0).max(1),
    anchor_overlap: z.number().min(0).max(1),
  }),
  verdict: VoteVerdictSchema,
  /** 2:1 时必填：少数派理由留档 */
  minority: z
    .object({ conclusion: z.string(), reason: z.string(), anchors: z.array(AnchorSchema) })
    .nullable()
    .default(null),
});
export type VoteRecord = z.infer<typeof VoteRecordSchema>;

/** 锚点独立度阈值初值（待实验一校准，见 docs/05） */
export const ANCHOR_OVERLAP_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// 门禁与工作流（ADR-0014 / ADR-0018；M2 只有内置 checker）
// ---------------------------------------------------------------------------

export const GateResultSchema = z.object({
  result: z.enum(["pass", "block", "warn"]),
  anchors: z.array(AnchorSchema).default([]),
  reason: z.string(),
  confidence: z.number().min(0).max(1).default(1),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/** gate 结果（result）与后续动作（action）正交（codex 评审 P1） */
export const GateActionSchema = z.enum(["continue", "escalate", "stop"]);
export type GateAction = z.infer<typeof GateActionSchema>;

export const GateDefSchema = z.object({
  id: z.string().min(1),
  role: z.object({
    initiators: z.array(z.string()).default([]),
    approvers: z.array(z.string()).default([]),
  }),
  attach: z.object({
    node: z.string().min(1),
    when: z.enum(["pre", "post"]),
    triggers: z.array(z.string()).default([]),
  }),
  /** M2：仅内置 checker 名；CEL/外部插件后置（M3） */
  checks: z.array(z.object({ ref: z.string().min(1) })),
  pass: z.object({
    require: z.enum(["all", "any"]).default("all"),
    human_confirm: z.boolean().default(false),
  }),
  on_fail: z.enum(["block", "warn", "escalate"]).default("block"),
  write_back: z
    .array(z.enum(["consensus_ledger", "session_event", "doc_block_draft", "knowledge_entry"]))
    .default([]),
  timeout: z
    .object({ after: z.string(), on_timeout: z.literal("escalate_human") })
    .optional(),
});
export type GateDef = z.infer<typeof GateDefSchema>;

export const WorkflowDefSchema = z.object({
  apiVersion: z.literal("agent-cord.dev/v1alpha1"),
  kind: z.literal("Workflow"),
  metadata: z.object({ id: z.string().min(1), name: z.string().optional() }),
  spec: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          artifact: z.string().optional(),
          depends_on: z.array(z.string()).default([]),
          gates: z.array(GateDefSchema).default([]),
        }),
      )
      .min(1),
  }),
});
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

// ---------------------------------------------------------------------------
// 事件 payload 的已知类型（封闭枚举，新增走 ADR）
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "session.created",
  "cli.message.received",
  "ledger.entry.proposed",
  "ledger.entry.confirmed",
  "ledger.entry.reconfirmed",
  "ledger.entry.overturn_requested",
  "ledger.entry.overturned",
  "ledger.entry.anchor_drifted",
  "ledger.conflict_detected",
  "vote.started",
  "vote.completed",
  "gate.waiting",
  "gate.resolved",
  "workflow.node.entered",
  "workflow.node.exited",
  "human.decision.recorded",
  "reconcile.requested",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// 事件 payload（已落地写入者的实际形状）
//
// 宽松对象：未知字段不报错（前向兼容），只固化「读者依赖的键」。这些 schema 是文档化契约，
// 不在写路径上强制（事件流不可变，历史事件必须永远可读）；消费方校验用 safeParse。
// ---------------------------------------------------------------------------

export const ConfidenceSourceSchema = z.enum(["vote_agreement", "human_confirmation", "evidence_direct"]);

/** `cli.message.received`：CLI 适配器的入站归一化结果（ADR-0012） */
export const CliMessageReceivedPayloadSchema = z.looseObject({
  kind: z.enum(["command", "message"]),
  text: z.string(),
  argv: z.array(z.string()),
  raw_id: z.string().min(1),
});

/** `human.decision.recorded`：门禁选择题的一次结构化记录（含超时/EOF 兜底） */
export const HumanDecisionRecordedPayloadSchema = z.looseObject({
  question: z.string(),
  options: z.array(z.string()).min(1),
  chosen: z.string(),
  chosen_index: z.number().int().nonnegative(),
  timeout_ms: z.number().int().nullable(),
  default_index: z.number().int().nonnegative(),
  fallback: z.enum(["timeout", "eof"]).nullable(),
  raw_input: z.string().nullable(),
});

/** `ledger.entry.proposed`：条目标识可平铺（entry_id / entryId）或嵌在 `entry` 下（reducer 两种都收） */
export const LedgerEntryProposedPayloadSchema = z
  .looseObject({
    entry_id: z.string().min(1).optional(),
    entryId: z.string().min(1).optional(),
    entry: z.looseObject({ entry_id: z.string().min(1), title: z.string().min(1) }).optional(),
    title: z.string().min(1).optional(),
    statement: z.string().optional(),
    anchors: z.array(AnchorSchema).min(1).optional(),
    confidence_source: ConfidenceSourceSchema.optional(),
    vote_record_id: z.string().nullable().optional(),
  })
  .refine((payload) => payload.entry_id !== undefined || payload.entryId !== undefined || payload.entry !== undefined, {
    message: "缺少条目标识：entry_id / entryId（平铺）或 entry.entry_id（嵌套）",
  });

/** 状态流转事件（confirmed / overturned / anchor_drifted）的公共字段 */
const ledgerTransitionFields = {
  entry_id: z.string().min(1),
  /** 条件写入：与当前投影不符时 reducer 只标 conflict，不静默择胜 */
  expected_status: LedgerStatusSchema.optional(),
  based_on: z.string().optional(),
  reason: z.string().optional(),
};

export const LedgerEntryConfirmedPayloadSchema = z.looseObject({
  ...ledgerTransitionFields,
  confidence_source: ConfidenceSourceSchema.optional(),
  vote_record_id: z.string().nullable().optional(),
  anchors: z.array(AnchorSchema).optional(),
});

export const LedgerEntryOverturnedPayloadSchema = z.looseObject({
  ...ledgerTransitionFields,
  overturn_reason: z.string().optional(),
  superseded_by: z.string().nullable().optional(),
});

export const LedgerEntryAnchorDriftedPayloadSchema = z.looseObject({ ...ledgerTransitionFields });

/** `vote.completed`：投票结论的落账形态（判定值见 `decision`，完整记录见 `vote_record`） */
export const VoteCompletedPayloadSchema = z.looseObject({
  vote_id: z.string().min(1),
  decision: z.string().min(1),
  entry_id: z.string().optional(),
  anchor_overlap: z.number().min(0).max(1).optional(),
  vote_record: z.unknown().optional(),
});

/** `gate.waiting`：执行器写（人工等待挂起） */
export const GateWaitingPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  gate_id: z.string().min(1),
  phase: z.enum(["pre", "post"]).optional(),
  kind: z.enum(["human_confirm", "escalation"]).optional(),
  question: z.string().optional(),
  options: z.array(z.string()).min(2).optional(),
  reason: z.string().optional(),
  result: z.enum(["pass", "warn"]).nullable().optional(),
  timed_out: z.boolean().optional(),
});

/** `gate.resolved`：执行器写（含 checks/人工分支）与 CLI 直达写（含 entry_ids）两种形态共用 */
export const GateResolvedPayloadSchema = z.looseObject({
  gate_id: z.string().min(1),
  result: z.enum(["pass", "block", "warn"]),
  action: GateActionSchema,
  reason: z.string(),
  workflow_id: z.string().optional(),
  node_id: z.string().optional(),
  phase: z.enum(["pre", "post"]).optional(),
  checks: z.array(z.looseObject({ ref: z.string(), result: z.enum(["pass", "block", "warn"]), reason: z.string() })).optional(),
  anchors: z.array(AnchorSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  human_confirmed: z.boolean().optional(),
  answer: z.string().optional(),
  write_back: z.array(z.string()).optional(),
  entry_ids: z.array(z.string()).optional(),
});

export const WorkflowNodeEnteredPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  artifact: z.string().nullable().optional(),
  resumed: z.boolean().optional(),
});

export const WorkflowNodeExitedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  artifact: z.string().nullable().optional(),
  gates: z
    .array(
      z.looseObject({
        gate_id: z.string().min(1),
        result: z.enum(["pass", "block", "warn"]),
        action: GateActionSchema,
        reason: z.string(),
      }),
    )
    .optional(),
});

/** 已知 payload 的 schema 表；未列出的类型（如 M3 才落地的 reconcile.requested）尚无固化形状。 */
export const EVENT_PAYLOAD_SCHEMAS: Partial<Record<EventType, z.ZodType>> = {
  "cli.message.received": CliMessageReceivedPayloadSchema,
  "human.decision.recorded": HumanDecisionRecordedPayloadSchema,
  "ledger.entry.proposed": LedgerEntryProposedPayloadSchema,
  "ledger.entry.confirmed": LedgerEntryConfirmedPayloadSchema,
  "ledger.entry.overturned": LedgerEntryOverturnedPayloadSchema,
  "ledger.entry.anchor_drifted": LedgerEntryAnchorDriftedPayloadSchema,
  "vote.completed": VoteCompletedPayloadSchema,
  "gate.waiting": GateWaitingPayloadSchema,
  "gate.resolved": GateResolvedPayloadSchema,
  "workflow.node.entered": WorkflowNodeEnteredPayloadSchema,
  "workflow.node.exited": WorkflowNodeExitedPayloadSchema,
};
