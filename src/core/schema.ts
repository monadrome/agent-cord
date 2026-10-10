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

export const GoalCommandSchema = z.strictObject({
  id: z.string().min(1).max(200),
  bin: z.string().min(1).max(500),
  args: z.array(z.string().max(10_000)).max(128).default([]),
  timeout_ms: z.number().int().positive().max(86_400_000).default(120_000),
});
export const GoalAcceptanceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  criterion: z.string().trim().min(1).max(500),
  checks: z.array(z.string().min(1).max(200)).min(1).max(16)
    .refine(values => new Set(values).size === values.length, "验收条件的检查引用不能重复"),
});
export const GoalAcceptanceEvidenceSchema = z.array(z.strictObject({
  acceptance_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  verification_event_ids: z.array(z.string().regex(ULID_RE)).min(1).max(16)
    .refine(values => new Set(values).size === values.length, "验收证据引用不能重复"),
})).min(1).max(16).refine(values => new Set(values.map(value => value.acceptance_id)).size === values.length, "验收证据条件不能重复");
export type GoalAcceptanceEvidence = z.infer<typeof GoalAcceptanceEvidenceSchema>;
export const GoalUsageBudgetSchema = z.strictObject({
  max_input_tokens: z.number().int().positive().max(1_000_000_000).optional(),
  max_output_tokens: z.number().int().positive().max(1_000_000_000).optional(),
  max_cost_usd: z.number().positive().max(1_000_000).optional(),
}).refine(value => Object.values(value).some(item => item !== undefined), "usage_budget 至少需要声明一项上限");
export const GoalUsageTotalsSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  observed_tasks: z.number().int().nonnegative(),
  unknown_tasks: z.number().int().nonnegative(),
  /** ADR-0067：新汇总逐指标完整计量；旧事件缺省时由任务事实重算。 */
  unknown_input_tasks: z.number().int().nonnegative().optional(),
  unknown_output_tasks: z.number().int().nonnegative().optional(),
  unknown_cost_tasks: z.number().int().nonnegative().optional(),
});
export type GoalUsageBudget = z.infer<typeof GoalUsageBudgetSchema>;
export type GoalUsageTotals = z.infer<typeof GoalUsageTotalsSchema>;
/** ADR-0071：源码观察只记录元信息，不保存内容；顺序与既有摘要域一致。 */
const SourcePathSchema = z.string().min(1).max(1000).refine(value => !/[\\\x00-\x1f\x7f]/u.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "源码清单路径必须规范且不含控制字符");
export const SourceEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ path: SourcePathSchema, kind: z.literal("file"), mode: z.number().int().min(0).max(0o777), content_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ path: SourcePathSchema, kind: z.literal("directory"), mode: z.number().int().min(0).max(0o777) }),
]);
export const SourceManifestSchema = z.array(SourceEntrySchema).min(1).max(10_000)
  .refine(values => values.every((entry, index) => index === 0 || values[index - 1]!.path < entry.path), "源码清单必须按路径唯一排序")
  .refine(values => JSON.stringify(values).length <= 1_000_000, "源码清单超过 1,000,000 字符预算");
export type SourceEntry = z.infer<typeof SourceEntrySchema>;
export type SourceManifest = z.infer<typeof SourceManifestSchema>;
export const GoalChangeEvidenceSchema = z.strictObject({
  baseline_event_id: z.string().regex(ULID_RE), baseline_source_hash: z.string().regex(/^[0-9a-f]{64}$/),
  changes: z.array(z.strictObject({ path: SourcePathSchema, status: z.enum(["added", "modified", "deleted"]),
    before: SourceEntrySchema.nullable(), after: SourceEntrySchema.nullable(),
  }).refine(value => (value.before === null || value.before.path === value.path) && (value.after === null || value.after.path === value.path), "变更路径与前后清单不一致")
    .refine(value => value.status === "added" ? value.before === null && value.after !== null
      : value.status === "deleted" ? value.before !== null && value.after === null : value.before !== null && value.after !== null, "变更状态与前后清单不一致"))
    .max(10_000).refine(values => values.every((entry, index) => index === 0 || values[index - 1]!.path < entry.path), "变更清单必须按路径唯一排序"),
}).refine(value => JSON.stringify(value).length <= 1_000_000, "变更证据超过 1,000,000 字符预算");
export type GoalChangeEvidence = z.infer<typeof GoalChangeEvidenceSchema>;
export const GoalConfigSchema = z.strictObject({
  inputs: z.array(z.string().min(1).max(500)).min(1).max(64),
  checks: z.array(GoalCommandSchema).min(1).max(16).refine(values => new Set(values.map(value => value.id)).size === values.length, "Goal 检查 id 必须唯一"),
  /** ADR-0064：显式验收清单，宿主绑定其实际验证事件。 */
  acceptance: z.array(GoalAcceptanceSchema).min(1).max(16)
    .refine(values => new Set(values.map(value => value.id)).size === values.length, "Goal 验收条件 id 必须唯一").optional(),
  /** ADR-0066：宿主按合法 task usage 累计，opt-in 资源边界。 */
  usage_budget: GoalUsageBudgetSchema.optional(),
  /** ADR-0071：宿主保存源码基线并审计交付变更；推荐模板默认开启。 */
  review_changes: z.boolean().optional(),
  max_attempts: z.number().int().min(1).max(10).default(3),
  timeout_ms: z.number().int().positive().max(86_400_000).default(1_800_000),
  no_progress_limit: z.number().int().min(1).max(10).default(2),
  /** ADR-0058：Goal 阻塞后自动发起受限协调；未声明不调用 supervisor。 */
  supervisor_agent: z.string().trim().min(1).max(200).optional(),
  supervisor_timeout_ms: z.number().int().positive().max(600_000).optional(),
}).refine(value => value.supervisor_timeout_ms === undefined || value.supervisor_agent !== undefined, "supervisor_timeout_ms 必须与 supervisor_agent 一起声明")
  .refine(value => value.acceptance === undefined || (value.acceptance.every(condition => condition.checks.every(id => value.checks.some(check => check.id === id)))
    && value.checks.every(check => value.acceptance!.some(condition => condition.checks.includes(check.id)))), "Goal 验收清单必须引用已声明检查且覆盖全部检查");
export type GoalConfig = z.infer<typeof GoalConfigSchema>;
export type GoalCommand = z.infer<typeof GoalCommandSchema>;

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
              /** ADR-0056：代码、自测与 review 指南在未退出节点内形成目标闭环。 */
              goal: GoalConfigSchema.optional(),
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
        }).refine(node => node.run?.goal === undefined || (node.artifact !== undefined && !node.run.readonly && node.run.retry === undefined), {
          path: ["run", "goal"], message: "Goal 必须声明 review artifact、保持可写且不能同时使用 run.retry",
        }),
      )
      .min(1),
  }),
});
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;
/** ADR-0034：公开 workflow 名称与执行版本分离，省略版本为库的兼容模式。 */
export const WorkflowScopeSchema = z.object({ workflow_id: z.string().min(1), workflow_revision: z.string().length(64).optional() });
export type WorkflowScope = z.infer<typeof WorkflowScopeSchema>;

function verificationExitIsConsistent(value: { status: string; exit_code?: number | null }): boolean {
  return value.status !== "passed" || value.exit_code == null || value.exit_code === 0;
}

/** ADR-0044：协调者只接收受限机器观察，不携带日志或事件正文。 */
export const CoordinationVerificationSchema = z.strictObject({
  run_id: z.string().regex(ULID_RE).nullable(),
  node_id: z.string().min(1).max(500),
  verification_id: z.string().min(1).max(200),
  event_id: z.string().regex(ULID_RE).nullable(),
  status: z.enum(["missing", "invalid", "passed", "failed", "timeout", "cancelled"]),
  current: z.boolean().nullable(),
  reason: z.enum(["missing", "invalid_result", "unavailable", "stale_input", "run_cancelled", "current"]),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  command_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  source_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  exit_code: z.number().int().nullable(),
}).refine(verificationExitIsConsistent, {
  path: ["exit_code"], message: "passed 不能与非零退出码同时声明",
}).refine((value) => value.current !== true || (value.event_id !== null && !["missing", "invalid"].includes(value.status)
  && value.reason === "current" && value.run_id !== null && value.input_hash !== null && value.command_hash !== null), {
  message: "当前有效验证必须携带完整结果身份",
});
export type CoordinationVerification = z.infer<typeof CoordinationVerificationSchema>;
export const CoordinationVerificationsSchema = z.array(CoordinationVerificationSchema).max(128).refine((values) =>
  new Set(values.map((value) => JSON.stringify([value.node_id, value.verification_id]))).size === values.length,
  { message: "同一节点的验证观察不能重复" });

/** ADR-0048：当前 run 的受限任务事实，不携带正文/错误日志。 */
export const CoordinationTaskSchema = z.strictObject({
  node_id: z.string().min(1).max(500),
  run_id: z.string().regex(ULID_RE).nullable(),
  event_id: z.string().regex(ULID_RE).nullable(),
  /** ADR-0049：reused 指向原始真实完成，其他状态为 null。 */
  completion_event_id: z.string().regex(ULID_RE).nullable().default(null),
  status: z.enum(["missing", "invalid", "started", "reused", "ok", "failed", "timeout", "cancelled"]),
  attempt: z.number().int().positive().nullable(),
  max_attempts: z.number().int().positive().nullable(),
  failure_stage: z.enum(["snapshot", "configuration", "driver", "artifact"]).nullable(),
  retryable: z.boolean().nullable(),
}).refine((value) => value.max_attempts === null || value.attempt === null || value.attempt <= value.max_attempts, { message: "重试编号超过上限" })
  .refine((value) => value.status === "missing" ? value.event_id === null : value.run_id !== null && value.event_id !== null, { message: "任务事实必须携带 run/event 身份" })
  .refine((value) => !["missing", "invalid", "started", "reused"].includes(value.status) || (value.failure_stage === null && value.retryable === null), { message: "未确认终态或复用不能携带失败结论" })
  .refine((value) => !["missing", "invalid", "reused"].includes(value.status) || (value.attempt === null && value.max_attempts === null), { message: "缺失/非法/复用任务不能声明新的重试编号" })
  .refine((value) => value.status !== "ok" || value.failure_stage === null, { message: "成功任务不能同时声明失败阶段" })
  .refine((value) => value.status === "reused" ? value.completion_event_id !== null && value.completion_event_id !== value.event_id : value.completion_event_id === null,
    { message: "只有复用任务可引用不同的原完成事件" });
export type CoordinationTask = z.infer<typeof CoordinationTaskSchema>;
/** ADR-0057：节点内 Goal 的受限当前观察；不携带 worker 正文或命令输出。 */
export const CoordinationGoalSchema = z.strictObject({
  node_id: z.string().min(1).max(500),
  run_id: z.string().regex(ULID_RE).nullable(),
  event_id: z.string().regex(ULID_RE).nullable(),
  status: z.enum(["missing", "invalid", "started", "retrying", "ready", "blocked", "cancelled"]),
  current: z.boolean().nullable().default(null),
  freshness_reason: z.enum(["not_ready", "current", "stale_input", "unavailable", "invalid_evidence", "run_cancelled"]).default("not_ready"),
  attempt: z.number().int().positive().nullable(),
  max_attempts: z.number().int().positive().nullable(),
  failure_kind: z.enum(["configuration", "environment", "input_changed", "verification", "delivery", "driver", "budget", "no_progress", "attempt_limit", "cancelled"]).nullable(),
  reason: z.string().max(2_000).nullable(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  source_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  artifact_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  verification_event_ids: z.array(z.string().regex(ULID_RE)).max(16),
  acceptance_evidence: GoalAcceptanceEvidenceSchema.optional(),
  usage_budget: GoalUsageBudgetSchema.optional(),
  usage_totals: GoalUsageTotalsSchema.optional(),
}).refine(value => value.acceptance_evidence === undefined || value.status === "ready", "仅 ready Goal 可声明验收通过证据")
  .refine(value => value.status === "missing" || (value.run_id !== null && value.event_id !== null), { message: "当前 Goal 观察必须绑定 run/event" })
  .refine(value => value.max_attempts === null || value.attempt === null || value.attempt <= value.max_attempts, { message: "Goal 尝试编号超过上限" })
  .refine(value => value.current !== true || (value.status === "ready" && value.freshness_reason === "current" && value.input_hash !== null
    && value.source_hash !== null && value.artifact_hash !== null && value.verification_event_ids.length > 0), "当前 Goal 就绪必须携带完整身份")
  .refine(value => value.current === true ? value.freshness_reason === "current" : value.current === false
    ? ["stale_input", "invalid_evidence", "run_cancelled"].includes(value.freshness_reason) : ["not_ready", "unavailable"].includes(value.freshness_reason), "Goal 新鲜度与原因不一致");
export type CoordinationGoal = z.infer<typeof CoordinationGoalSchema>;
export const CoordinationGoalsSchema = z.array(CoordinationGoalSchema).max(128).refine(values =>
  new Set(values.map(value => value.node_id)).size === values.length, { message: "Goal 观察节点不能重复" });
export const CoordinationExecutionContextSchema = z.strictObject({
  run: z.strictObject({ run_id: z.string().regex(ULID_RE), status: z.enum(["running", "waiting_human", "completed", "blocked", "failed", "cancelled"]), active: z.boolean() })
    .refine((value) => !value.active || ["running", "waiting_human"].includes(value.status), { message: "终态 run 不能仍 active" }).nullable(),
  tasks: z.array(CoordinationTaskSchema).max(128),
  goals: CoordinationGoalsSchema.default([]),
}).refine((value) => new Set(value.tasks.map((task) => task.node_id)).size === value.tasks.length, { message: "任务节点不能重复" })
  .refine((value) => { const ids = value.tasks.flatMap((task) => task.event_id === null ? [] : [task.event_id]); return new Set(ids).size === ids.length; }, { message: "同一任务事件不能归属多个节点" })
  .refine((value) => value.tasks.every((task) => task.run_id === (value.run?.run_id ?? null)), { message: "任务观察必须属于当前 run" })
  .refine((value) => value.run !== null || value.tasks.every((task) => task.status === "missing"), { message: "没有当前 run 时不能声明任务事实" })
  .refine(value => value.goals.every(goal => goal.run_id === (value.run?.run_id ?? null)), "Goal 观察必须属于当前 run")
  .refine(value => value.run !== null || value.goals.every(goal => goal.status === "missing"), "没有当前 run 时不能声明 Goal 事实");
export type CoordinationExecutionContext = z.infer<typeof CoordinationExecutionContextSchema>;
/** 观察 hook 输入允许省略有默认值的新字段，消费端始终归一化。 */
export type CoordinationExecutionContextInput = z.input<typeof CoordinationExecutionContextSchema>;

/** ADR-0058：自动协调只解释这个已持久化的 blocker。 */
export const GoalBlockerTriggerSchema = z.strictObject({
  run_id: z.string().regex(ULID_RE), node_id: z.string().min(1).max(500), goal_event_id: z.string().regex(ULID_RE),
});
export type GoalBlockerTrigger = z.infer<typeof GoalBlockerTriggerSchema>;

/** ADR-0032：协调提议仅引用当前快照/工作流，不能携带任意命令或修改协议。 */
export const CoordinationEvidenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("document"), id: z.string().min(1).max(500) }),
  z.strictObject({ source: z.literal("ledger"), id: z.string().regex(/^C-\d+$/) }),
  z.strictObject({ source: z.literal("workflow"), id: z.string().min(1).max(500) }),
  z.strictObject({ source: z.literal("verification"), id: z.string().regex(ULID_RE) }),
  z.strictObject({ source: z.literal("agent_task"), id: z.string().regex(ULID_RE) }),
  z.strictObject({ source: z.literal("goal"), id: z.string().regex(ULID_RE) }),
  z.strictObject({ source: z.literal("clarification"), id: z.string().regex(ULID_RE) }),
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
  "agent.task.reused",
  "verification.completed",
  "goal.attempt.started",
  "goal.attempt.completed",
  "goal.retry.authorized",
  "goal.recovery.requested",
  "coordinator.round.started",
  "coordinator.round.requested",
  "coordinator.round.completed",
  "coordinator.round.answered",
  "coordinator.round.answer_revoked",
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
  run_id: z.string().regex(ULID_RE).optional(),
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
  run_id: z.string().regex(ULID_RE).optional(),
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

/** ADR-0049：当前 run 使用已核验的旧 checkpoint，不代表新的模型执行。 */
export const AgentTaskReusedPayloadSchema = z.looseObject({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  run_id: z.string().regex(ULID_RE),
  node_id: z.string().min(1),
  completion_event_id: z.string().regex(ULID_RE),
  execution_input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  agent_configuration_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  source_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  artifact_after_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});

/** ADR-0045：REST 与事实消费共用结果约束，未知退出码不补造为 0。 */
export const VerificationResultSchema = z.strictObject({
  verification_id: z.string().min(1).max(200),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  command_hash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["passed", "failed", "timeout", "cancelled"]),
  exit_code: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  stdout_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  stderr_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  summary: z.string().max(2_000).optional(),
}).refine(verificationExitIsConsistent, {
  path: ["exit_code"], message: "passed 不能与非零退出码同时声明",
});

/** `verification.completed`：宿主/CI 写入的机器验证结果，不接受 agent 正文冒充。 */
export const VerificationCompletedPayloadSchema = VerificationResultSchema.loose().safeExtend({
  workflow_id: z.string().min(1),
  workflow_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  run_id: z.string().regex(ULID_RE),
  node_id: z.string().min(1),
  /** ADR-0041：由宿主计算的声明源码输入摘要，不保存源码正文。 */
  source_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const GoalAttemptStartedPayloadSchema = z.strictObject({
  workflow_id: z.string().min(1), workflow_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  run_id: z.string().regex(ULID_RE), node_id: z.string().min(1), attempt: z.number().int().positive().max(10),
  source_manifest: SourceManifestSchema.optional(),
});
export const GoalAttemptCompletedPayloadSchema = GoalAttemptStartedPayloadSchema.omit({ source_manifest: true }).safeExtend({
  max_attempts: z.number().int().positive().max(10).optional(),
  status: z.enum(["ready", "retrying", "blocked", "cancelled"]),
  failure_kind: z.enum(["configuration", "environment", "input_changed", "verification", "delivery", "driver", "budget", "no_progress", "attempt_limit", "cancelled"]).optional(),
  reason: z.string().max(2000),
  completion_event_id: z.string().regex(ULID_RE).optional(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  source_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  artifact_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  verification_event_ids: z.array(z.string().regex(ULID_RE)).max(16).default([]),
  acceptance_evidence: GoalAcceptanceEvidenceSchema.optional(),
  usage_budget: GoalUsageBudgetSchema.optional(),
  usage_totals: GoalUsageTotalsSchema.optional(),
  change_evidence: GoalChangeEvidenceSchema.optional(),
  progress_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).refine(value => value.acceptance_evidence === undefined || value.status === "ready", "仅 ready Goal 可声明验收通过证据")
  .refine(value => value.change_evidence === undefined || value.status === "ready", "仅 ready Goal 可声明源码变更证据")
  .refine(value => value.status !== "ready" || (value.failure_kind === undefined && value.completion_event_id !== undefined
  && value.input_hash !== undefined && value.source_hash !== undefined && value.artifact_hash !== undefined && value.verification_event_ids.length > 0), "Goal ready 必须携带当前交付与验证身份");

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
  goal_retry_round_id: z.string().regex(ULID_RE).optional(),
}).refine(value => value.coordination_round_id === undefined || value.goal_retry_round_id === undefined, "人工采用与 Goal 续跑来源必须互斥");

export const GoalRetryAuthorizedPayloadSchema = z.strictObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1), workflow_revision: z.string().regex(/^[0-9a-f]{64}$/),
  run_id: z.string().regex(ULID_RE), failed_run_id: z.string().regex(ULID_RE), node_id: z.string().min(1),
  goal_event_id: z.string().regex(ULID_RE), answer_event_id: z.string().regex(ULID_RE), input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  max_attempts: z.number().int().min(1).max(10), timeout_ms: z.number().int().positive().max(86_400_000),
  /** ADR-0062：新授权保存完整身份组；旧事件可以全部缺省。 */
  agent_configuration_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  supervisor_configuration_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  node_input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).refine(value => [value.agent_configuration_hash, value.supervisor_configuration_hash, value.node_input_hash]
  .filter(hash => hash !== undefined).length % 3 === 0, "Goal 授权配置与输入身份必须完整声明");

/** ADR-0063：恢复原授权，不授予新次数/时长，也不等同人工 gate 决定。 */
export const GoalRecoveryRequestedPayloadSchema = z.strictObject({
  workflow_id: z.string().min(1), workflow_revision: z.string().regex(/^[0-9a-f]{64}$/),
  run_id: z.string().regex(ULID_RE), node_id: z.string().min(1), authorization_event_id: z.string().regex(ULID_RE),
  checkpoint_event_id: z.string().regex(ULID_RE).nullable(), prior_request_event_id: z.string().regex(ULID_RE).nullable(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/), node_input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  agent_configuration_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const coordination_round_fields = {
  round_id: z.string().regex(ULID_RE),
  workflow_id: z.string().min(1),
  driver: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  input_hash: z.string().length(64).optional(),
  prompt_hash: z.string().length(64).optional(),
  agent_configuration_hash: z.string().length(64).optional(),
  /** ADR-0043：独立协调轮次声明的源码范围摘要。 */
  source_hash: z.string().length(64).optional(),
  /** ADR-0044：完整验证观察的摘要，正文不保存到轮次。 */
  verification_context_hash: z.string().length(64).optional(),
  /** ADR-0048：run/worker 受限执行观察摘要。 */
  execution_context_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  snapshot_id: z.string().length(64).optional(),
  snapshot_event_seq: z.number().int().nonnegative().optional(),
  snapshot_event_chain_hash: z.string().length(64).optional(),
};
export const CoordinatorRoundStartedPayloadSchema = z.looseObject(coordination_round_fields);
export const CoordinatorRoundRequestedPayloadSchema = z.looseObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1), driver: z.string().min(1),
  workflow_revision: z.string().length(64).optional(),
  sdlc_id: z.string().min(1), sdlc_version: z.number().int().positive(),
  retry_of_round_id: z.string().regex(ULID_RE).optional(),
  retry_input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  retry_configuration_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  trigger: z.literal("goal_blocked").optional(),
  run_id: z.string().regex(ULID_RE).optional(), node_id: z.string().min(1).optional(), goal_event_id: z.string().regex(ULID_RE).optional(),
}).refine(value => value.trigger === undefined
  ? value.run_id === undefined && value.node_id === undefined && value.goal_event_id === undefined
  : value.run_id !== undefined && value.node_id !== undefined && value.goal_event_id !== undefined, "自动协调请求必须携带完整 Goal 来源")
  .refine(value => [value.retry_of_round_id, value.retry_input_hash, value.retry_configuration_hash].filter(item => item !== undefined).length % 3 === 0
    && (value.retry_of_round_id === undefined || (value.trigger === "goal_blocked" && value.retry_of_round_id !== value.round_id)), "协调重试来源必须完整声明且属于另一 Goal 轮次");
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

/** ADR-0052：人工澄清引用原问题完成，不是 gate 决策。 */
export const CoordinatorRoundAnsweredPayloadSchema = z.strictObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1),
  workflow_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  completion_event_id: z.string().regex(ULID_RE), input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  choice: z.string().min(1).max(500),
});
/** ADR-0053：撤回指定答复，原事实与 gate 均不改写。 */
export const CoordinatorRoundAnswerRevokedPayloadSchema = z.strictObject({
  round_id: z.string().regex(ULID_RE), workflow_id: z.string().min(1),
  workflow_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(), answer_event_id: z.string().regex(ULID_RE),
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
  "agent.task.reused": AgentTaskReusedPayloadSchema,
  "verification.completed": VerificationCompletedPayloadSchema,
  "goal.attempt.started": GoalAttemptStartedPayloadSchema,
  "goal.attempt.completed": GoalAttemptCompletedPayloadSchema,
  "goal.retry.authorized": GoalRetryAuthorizedPayloadSchema,
  "goal.recovery.requested": GoalRecoveryRequestedPayloadSchema,
  "coordinator.round.started": CoordinatorRoundStartedPayloadSchema,
  "coordinator.round.requested": CoordinatorRoundRequestedPayloadSchema,
  "coordinator.round.completed": CoordinatorRoundCompletedPayloadSchema,
  "coordinator.round.answered": CoordinatorRoundAnsweredPayloadSchema,
  "coordinator.round.answer_revoked": CoordinatorRoundAnswerRevokedPayloadSchema,
  "coordinator.round.cancel_requested": CoordinatorRoundCancelRequestedPayloadSchema,
  "coordinator.round.adopted": CoordinatorRoundAdoptedPayloadSchema,
};
