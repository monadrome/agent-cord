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
  /** M2：仅内置 checker 名；CEL/外部插件后置（M3）。ADR-0024：with 为 checker 参数（v1alpha1 非破坏性新增） */
  checks: z.array(
    z.object({
      ref: z.string().min(1),
      /** 传给 checker 的参数（CheckerContext.params）；参数非法由 checker fail-closed */
      with: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
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
          /** 节点执行体（ADR-0023）：声明后由注入的 NodeRunner 调度 agent 执行；缺省节点无执行体 */
          run: z
            .object({
              /** 驱动名（registry 语法：claude / acp:kimi / headless:codex / agents.yaml 别名） */
              agent: z.string().min(1),
              /** 任务模板（支持 {{req_id}} / {{node_id}} / {{artifact}} 占位）；缺省按产物类型给模板 */
              prompt: z.string().optional(),
              readonly: z.boolean().default(false),
              /** ADR-0038：text 仅返回完整文本，声明产物由 coordinator 代写；auto 保持原行为。 */
              output: z.enum(["auto", "text"]).optional(),
              timeout_ms: z.number().int().positive().optional(),
              /**
               * 失败重试（agent 任务 flaky 是常态：限流/网络）：max_attempts 含首次，默认 1 = 不重试；
               * backoff_ms 为逐次等待基数（线性）。每次尝试都落 agent.task.started/completed（带 attempt 编号）。
               */
              retry: z
                .object({
                  max_attempts: z.number().int().min(1).max(10).default(1),
                  backoff_ms: z.number().int().min(0).default(0),
                })
                .optional(),
            })
            .optional(),
          gates: z.array(GateDefSchema).default([]),
        }).refine((node) => node.run?.output !== "text" || node.artifact !== undefined, {
          path: ["run", "output"], message: "output=text 必须声明节点 artifact",
        }),
      )
      .min(1),
  }),
});
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;
/** ADR-0034：公开 workflow 名称与执行版本分离，省略版本为库的兼容模式。 */
export const WorkflowScopeSchema = z.object({ workflow_id: z.string().min(1), workflow_revision: z.string().length(64).optional() });
export type WorkflowScope = z.infer<typeof WorkflowScopeSchema>;

/** ADR-0032：协调提议仅引用当前快照/工作流，不能携带任意命令或修改协议。 */
export const CoordinationEvidenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("document"), id: z.string().min(1).max(500) }),
  z.strictObject({ source: z.literal("ledger"), id: z.string().regex(/^C-\d+$/) }),
  z.strictObject({ source: z.literal("workflow"), id: z.string().min(1).max(500) }),
]);
const coordination_action_fields = {
  reason: z.string().trim().min(1).max(2_000),
  evidence: z.array(CoordinationEvidenceSchema).min(1).max(8),
};
export const CoordinationProposalSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2_000),
  next_action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("advance"), node_id: z.string().min(1).max(500), ...coordination_action_fields }),
    z.strictObject({ kind: z.literal("ask_human"), question: z.string().trim().min(1).max(2_000), options: z.array(z.string().trim().min(1).max(500)).min(2).max(6), ...coordination_action_fields }),
    z.strictObject({ kind: z.literal("wait"), ...coordination_action_fields }),
    z.strictObject({ kind: z.literal("complete"), ...coordination_action_fields }),
  ]),
  risks: z.array(z.string().trim().min(1).max(1_000)).max(10),
});
export type CoordinationProposal = z.infer<typeof CoordinationProposalSchema>;
export const CoordinationStatusSchema = z.enum(["ok", "failed", "timeout", "cancelled", "stale"]);
export type CoordinationStatus = z.infer<typeof CoordinationStatusSchema>;

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
  "gate.invalidated",
  "gate.resolved",
  "workflow.node.entered",
  "workflow.node.exited",
  "workflow.run.cancelled",
  "workflow.run.started",
  "agent.task.started",
  "agent.task.completed",
  "verification.completed",
  "coordinator.round.started",
  "coordinator.round.requested",
  "coordinator.round.completed",
  "coordinator.round.cancel_requested",
  "coordinator.round.adopted",
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
  workflow_id: z.string().min(1).optional(),
  workflow_revision: z.string().length(64).optional(),
  waiting_event_id: z.string().regex(ULID_RE).optional(),
  evaluation_hash: z.string().length(64).optional(),
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
  workflow_revision: z.string().length(64).optional(),
  node_id: z.string().min(1),
  gate_id: z.string().min(1),
  phase: z.enum(["pre", "post"]).optional(),
  kind: z.enum(["human_confirm", "escalation"]).optional(),
  question: z.string().optional(),
  options: z.array(z.string()).min(2).optional(),
  reason: z.string().optional(),
  result: z.enum(["pass", "warn"]).nullable().optional(),
  timed_out: z.boolean().optional(),
  /** ADR-0030：审批的证据版本，与控制事件序号独立 */
  evaluation_hash: z.string().length(64).optional(),
});

export const GateInvalidatedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1), node_id: z.string().min(1), gate_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  waiting_event_id: z.string().regex(ULID_RE), reason: z.string(),
});

/** `gate.resolved`：执行器写（含 checks/人工分支）与 CLI 直达写（含 entry_ids）两种形态共用 */
export const GateResolvedPayloadSchema = z.looseObject({
  waiting_event_id: z.string().regex(ULID_RE).optional(),
  evaluation_hash: z.string().length(64).optional(),
  gate_id: z.string().min(1),
  result: z.enum(["pass", "block", "warn"]),
  action: GateActionSchema,
  reason: z.string(),
  workflow_id: z.string().optional(),
  workflow_revision: z.string().length(64).optional(),
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
  workflow_revision: z.string().length(64).optional(),
  node_id: z.string().min(1),
  artifact: z.string().nullable().optional(),
  resumed: z.boolean().optional(),
});

export const WorkflowNodeExitedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
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

/** `agent.task.started`：协调 agent 派发节点任务（ADR-0023） */
export const AgentTaskStartedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  node_id: z.string().min(1),
  driver: z.string().min(1),
  output: z.enum(["auto", "text"]).optional(),
  execution_input_hash: z.string().length(64).optional(),
  agent_configuration_hash: z.string().length(64).optional(),
  /** ADR-0042：只读 worker 声明的源码输入摘要。 */
  source_hash: z.string().length(64).optional(),
  /** ADR-0029：派发时 artifact 的完整内容 hash，不存在为 null */
  artifact_before_hash: z.string().length(64).nullable().optional(),
  prompt_excerpt: z.string().optional(),
  /** 重试编号（node.run.retry）；首次为 1 */
  attempt: z.number().int().positive().optional(),
  max_attempts: z.number().int().positive().optional(),
  /** ADR-0026：worker 使用的最新快照 provenance */
  snapshot_id: z.string().length(64).optional(),
  snapshot_event_seq: z.number().int().nonnegative().optional(),
  snapshot_event_chain_hash: z.string().length(64).optional(),
});

/** 规范化用量槽位（ADR-0023 决策 3 的 usage）：各厂商原始字段映射到统一口径，原始负载留 driver 层 raw */
export const AgentUsagePayloadSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  /** 命中缓存的输入 token（claude cache_read / codex cached_input / ACP cachedRead） */
  cached_input_tokens: z.number().optional(),
  /** 成本（美元）；目前仅 claude 原生提供 */
  cost_usd: z.number().optional(),
  /** agent 轮次（claude num_turns） */
  num_turns: z.number().optional(),
});

/** `agent.task.completed`：节点任务终态（中间流式事件不入事件流，ADR-0023 决策 3） */
export const AgentTaskCompletedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  node_id: z.string().min(1),
  driver: z.string().min(1),
  output: z.enum(["auto", "text"]).optional(),
  execution_input_hash: z.string().length(64).optional(),
  agent_configuration_hash: z.string().length(64).optional(),
  source_hash: z.string().length(64).optional(),
  status: z.enum(["ok", "failed", "timeout", "cancelled"]),
  /** ADR-0028：失败阶段与本次失败是否允许节点内重试 */
  failure_stage: z.enum(["snapshot", "configuration", "driver", "artifact"]).optional(),
  retryable: z.boolean().optional(),
  text: z.string().optional(),
  error: z.string().nullable().optional(),
  artifact: z.string().nullable().optional(),
  artifact_written: z.boolean().optional(),
  /** ADR-0029：本次任务的产物前后证据，无法读取后态时不填 after/changed */
  artifact_before_hash: z.string().length(64).nullable().optional(),
  artifact_after_hash: z.string().length(64).nullable().optional(),
  artifact_changed: z.boolean().optional(),
  /** 产物写入通道：agent 自写 / 协调 agent 代写（draft）/ 无产物 */
  written_by: z.enum(["agent", "coordinator", "none"]).optional(),
  /** worker agent 的会话 id（仅供人工调试 resume；执行器恢复总是新会话） */
  agent_session_id: z.string().nullable().optional(),
  duration_ms: z.number().optional(),
  usage: AgentUsagePayloadSchema.nullable().optional(),
  /** 重试编号（node.run.retry）；首次为 1 */
  attempt: z.number().int().positive().optional(),
  max_attempts: z.number().int().positive().optional(),
  /** ADR-0026：worker 使用的最新快照 provenance */
  snapshot_id: z.string().length(64).optional(),
  snapshot_event_seq: z.number().int().nonnegative().optional(),
  snapshot_event_chain_hash: z.string().length(64).optional(),
});

/** `verification.completed`：宿主/CI 写入的机器验证结果，不接受 agent 正文冒充。 */
export const VerificationCompletedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  run_id: z.string().regex(ULID_RE),
  node_id: z.string().min(1),
  verification_id: z.string().min(1).max(200),
  input_hash: z.string().length(64),
  /** ADR-0041：由宿主计算的声明源码输入摘要，不保存源码正文。 */
  source_hash: z.string().length(64).optional(),
  command_hash: z.string().length(64),
  status: z.enum(["passed", "failed", "timeout", "cancelled"]),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  stdout_hash: z.string().length(64).optional(),
  stderr_hash: z.string().length(64).optional(),
  summary: z.string().max(2_000).optional(),
});

/** `workflow.run.cancelled`：run 取消（ADR-0025）。取消是事实：落盘后执行器在节点边界止步 */
export const WorkflowRunCancelledPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  run_id: z.string().min(1),
  reason: z.string().optional(),
});
export const WorkflowRunStartedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1), workflow_revision: z.string().length(64), run_id: z.string().regex(ULID_RE),
  sdlc_id: z.string().min(1), sdlc_version: z.number().int().positive(),
  coordination_round_id: z.string().regex(ULID_RE).optional(),
});

const coordination_round_fields = {
  round_id: z.string().regex(ULID_RE),
  workflow_id: z.string().min(1),
  driver: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  input_hash: z.string().length(64).optional(),
  prompt_hash: z.string().length(64).optional(),
  agent_configuration_hash: z.string().length(64).optional(),
  snapshot_id: z.string().length(64).optional(),
  snapshot_event_seq: z.number().int().nonnegative().optional(),
  snapshot_event_chain_hash: z.string().length(64).optional(),
};
export const CoordinatorRoundStartedPayloadSchema = z.looseObject(coordination_round_fields);
export const CoordinatorRoundRequestedPayloadSchema = z.looseObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1), driver: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  sdlc_id: z.string().min(1), sdlc_version: z.number().int().positive(),
});
export const CoordinatorRoundCompletedPayloadSchema = z.looseObject({
  ...coordination_round_fields,
  status: CoordinationStatusSchema,
  proposal: CoordinationProposalSchema.nullable(),
  error: z.string().nullable(),
  failure_stage: z.enum(["snapshot", "configuration", "driver", "output", "freshness", "interrupted"]).optional(),
  response_hash: z.string().length(64).optional(),
  duration_ms: z.number().nonnegative(),
  agent_session_id: z.string().nullable().optional(),
  usage: AgentUsagePayloadSchema.nullable().optional(),
}).refine((payload) => (payload.status === "ok") === (payload.proposal !== null), {
  message: "只有成功协调轮次可以携带提议，成功轮次必须携带提议",
});
export const CoordinatorRoundCancelRequestedPayloadSchema = z.looseObject({
  round_id: z.string().regex(ULID_RE),
  reason: z.string().optional(),
});
/** ADR-0033：人工采用当前提议，实际执行继续经绑定版本的 SDLC runner。 */
export const CoordinatorRoundAdoptedPayloadSchema = z.looseObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1), node_id: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  input_hash: z.string().length(64), run_id: z.string().regex(ULID_RE),
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
  "gate.invalidated": GateInvalidatedPayloadSchema,
  "gate.resolved": GateResolvedPayloadSchema,
  "workflow.node.entered": WorkflowNodeEnteredPayloadSchema,
  "workflow.node.exited": WorkflowNodeExitedPayloadSchema,
  "workflow.run.cancelled": WorkflowRunCancelledPayloadSchema,
  "workflow.run.started": WorkflowRunStartedPayloadSchema,
  "agent.task.started": AgentTaskStartedPayloadSchema,
  "agent.task.completed": AgentTaskCompletedPayloadSchema,
  "verification.completed": VerificationCompletedPayloadSchema,
  "coordinator.round.started": CoordinatorRoundStartedPayloadSchema,
  "coordinator.round.requested": CoordinatorRoundRequestedPayloadSchema,
  "coordinator.round.completed": CoordinatorRoundCompletedPayloadSchema,
  "coordinator.round.cancel_requested": CoordinatorRoundCancelRequestedPayloadSchema,
  "coordinator.round.adopted": CoordinatorRoundAdoptedPayloadSchema,
};
