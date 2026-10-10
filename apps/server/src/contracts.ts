/**
 * 控制台 API 契约（ADR-0021 决策 7）：REST/SSE 的 DTO 与命令输入的 zod schema。
 * 这是 server 与 console 之间的唯一共享契约，经 `@agent-cord/server/contracts` 导出；
 * 不修改 `src/core/schema.ts`（核心契约冻结边界不变），这里的类型是核心类型的 API 投影。
 */
import { z } from "zod";
import { ULID_RE, VerificationResultSchema } from "agent-cord";
import type { AgentCapabilities, AcpCapabilityObservation, CoordinationProposal, CoordinationStatus, GoalUsageBudget, GoalUsageTotals } from "agent-cord";

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 统一错误形状：{ code, message, details }（ADR-0021 决策 7） */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiOk {
  request_id: string;
}

/** 当前配置可解析的 agent 清单；不代表 CLI 已安装或凭据已验证。 */
export interface AgentCatalogView {
  revision: number;
  agents: Array<{
    name: string;
    kind: "acp" | "headless";
    source: "workspace" | "registry";
    template: string | null;
    configuration_hash: string | null;
    context_revision?: number;
    permission_policy?: { read_count: number; edit_count: number };
    capabilities?: AgentCapabilities;
  }>;
  warnings: string[];
  rejected: string[];
}
export const InspectAgentInputSchema = z.strictObject({ timeout_ms: z.number().int().min(100).max(10_000).optional() });
export interface AgentInspectionView {
  revision: number;
  configuration_hash: string | null;
  /** 返回时的配置快照新鲜度；幂等重放后消费方仍须核对最新清单。 */
  current: boolean;
  capabilities: AgentCapabilities | null;
  observation: AcpCapabilityObservation | null;
}

// ---------------------------------------------------------------------------
// 需求（requirement / session）
// ---------------------------------------------------------------------------

export type RequirementStatus = "idle" | "running" | "waiting_human" | "blocked" | "completed";

export interface RequirementSummary {
  req_id: string;
  title: string;
  created_at: string | null;
  event_count: number;
  status: RequirementStatus;
  current_node: string | null;
  pending_approvals: number;
  last_event_at: string | null;
}

export interface RequirementDetail extends RequirementSummary {
  docs: Record<SnapshotDocName, boolean>;
  artifacts?: Array<{ path: string; available: boolean }>;
  active_run: RunInfo | null;
  goal_recovery?: GoalRecoveryView | null;
}
export const ReadArtifactInputSchema = z.strictObject({ path: z.string().min(1).max(500) });

export const SNAPSHOT_DOC_NAMES = ["prd", "plan", "adr", "findings"] as const;
export type SnapshotDocName = (typeof SNAPSHOT_DOC_NAMES)[number];

export const CreateRequirementInputSchema = z.object({
  req_id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "req_id 只允许字母数字、-、_，长度 1-64")
    .optional(),
  title: z.string().min(1).max(200),
  prd: z.string().max(200_000).optional(),
});
export type CreateRequirementInput = z.infer<typeof CreateRequirementInputSchema>;

export const UpdateDocInputSchema = z.object({
  content: z.string().max(500_000),
});
export type UpdateDocInput = z.infer<typeof UpdateDocInputSchema>;

// ---------------------------------------------------------------------------
// 账本 / 证据（核心 Ledger 的 API 投影）
// ---------------------------------------------------------------------------

export interface AnchorView {
  kind: "code" | "test" | "contract" | "knowledge" | "doc";
  anchor: string;
  snapshot?: { commit?: string; lines?: string; content_hash?: string };
  line_hint?: string;
}

export interface LedgerEntryView {
  entry_id: string;
  title: string;
  status: "provisional" | "confirmed" | "overturned";
  anchors: AnchorView[];
  confidence_source: "vote_agreement" | "human_confirmation" | "evidence_direct";
  vote_record_id: string | null;
  superseded_by: string | null;
  overturn_reason: string | null;
  conflict: boolean;
}

export interface LedgerView {
  reducer_version: string;
  input_hash: string;
  output_hash: string;
  entries: LedgerEntryView[];
}

// ---------------------------------------------------------------------------
// 工作流时间线 / 运行实例
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "waiting_human" | "completed" | "blocked" | "failed" | "cancelled";

export const RecoverGoalInputSchema = z.strictObject({ input_hash: z.string().regex(/^[0-9a-f]{64}$/), node_id: z.string().min(1).max(200).optional() });
export type RecoverGoalInput = z.infer<typeof RecoverGoalInputSchema>;
export interface GoalRecoveryView {
  run_id: string;
  available: boolean;
  reason: string | null;
  input_hash: string | null;
  node_id: string | null;
  authorization_event_id: string | null;
  remaining_attempts: number | null;
  deadline_at: string | null;
  ready_current: boolean;
}

export interface RunInfo {
  run_id: string;
  req_id: string;
  sdlc_id: string;
  sdlc_version: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  workflow_revision: string | null;
  goal_retry_round_id?: string | null;
}

export interface GateState {
  gate_id: string;
  phase: "pre" | "post";
  waiting: boolean;
  result: "pass" | "block" | "warn" | null;
  action: "continue" | "escalate" | "stop" | null;
  reason: string | null;
  human_confirmed: boolean;
}

export interface TimelineNode {
  node_id: string;
  artifact: string | null;
  depends_on: string[];
  status: "pending" | "entered" | "exited";
  entered_at: string | null;
  exited_at: string | null;
  gates: GateState[];
}

export interface TimelineView {
  req_id: string;
  sdlc_id: string;
  sdlc_version: number | null;
  run: RunInfo | null;
  nodes: TimelineNode[];
}

export const StartRunInputSchema = z.object({
  sdlc_id: z.string().min(1).optional(),
  sdlc_version: z.number().int().positive().optional(),
});
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

/** 机器验证只提交摘要与状态，不把 stdout/stderr 正文写入事件流。 */
export const RecordVerificationInputSchema = VerificationResultSchema.safeExtend({
  run_id: z.string().regex(ULID_RE),
  node_id: z.string().min(1).max(200),
});
export type RecordVerificationInput = z.infer<typeof RecordVerificationInputSchema>;

export interface VerificationContextView {
  run_id: string;
  req_id: string;
  workflow_id: string;
  workflow_revision: string;
  node_id: string;
  input_hash: string;
  source_inputs: string[];
  source_hash: string | null;
}

/** ADR-0032：独立协调轮次，输出只有经宿主验证的 Draft 提议。 */
export const StartCoordinationInputSchema = z.strictObject({
  agent: z.string().trim().min(1).max(200),
  sdlc_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  sdlc_version: z.number().int().positive().optional(),
  timeout_ms: z.number().int().min(1).max(600_000).optional(),
});
export type StartCoordinationInput = z.infer<typeof StartCoordinationInputSchema>;
export const RetryCoordinationInputSchema = z.strictObject({ input_hash: z.string().regex(/^[0-9a-f]{64}$/) });
export type RetryCoordinationInput = z.infer<typeof RetryCoordinationInputSchema>;
export interface CoordinationRetryView { available: boolean; reason: string | null; input_hash: string | null; parent_round_id: string; child_round_id: string | null; }
export const AnswerCoordinationInputSchema = z.strictObject({ choice: z.string().trim().min(1).max(500) });
export type AnswerCoordinationInput = z.infer<typeof AnswerCoordinationInputSchema>;
export const RevokeCoordinationAnswerInputSchema = z.strictObject({ answer_event_id: z.string().regex(ULID_RE) });
export type RevokeCoordinationAnswerInput = z.infer<typeof RevokeCoordinationAnswerInputSchema>;
export const RetryGoalInputSchema = z.strictObject({ answer_event_id: z.string().regex(ULID_RE), input_hash: z.string().regex(/^[0-9a-f]{64}$/) });
export type RetryGoalInput = z.infer<typeof RetryGoalInputSchema>;
export interface GoalRetryView {
  available: boolean;
  reason: string | null;
  input_hash: string | null;
  max_attempts: number | null;
  timeout_ms: number | null;
  run_id: string | null;
}
export interface GoalUsageView {
  run_id: string | null;
  event_id: string | null;
  node_id: string;
  status: "not_started" | "observed" | "unknown" | "exceeded" | "invalid";
  reason: string | null;
  usage_budget: GoalUsageBudget;
  usage_totals: GoalUsageTotals | null;
}
export interface CoordinationRoundView {
  goal_usage?: GoalUsageView[];
  goal_retry?: GoalRetryView;
  coordination_retry?: CoordinationRetryView | null;
  trigger?: "goal_blocked";
  run_id?: string;
  node_id?: string;
  goal_event_id?: string;
  retry_of_round_id?: string;
  round_id: string;
  req_id: string;
  sdlc_id: string;
  sdlc_version: number;
  workflow_id: string;
  workflow_revision: string | null;
  driver: string;
  agent: string;
  status: "pending" | "running" | CoordinationStatus;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  snapshot_id: string | null;
  input_hash: string | null;
  agent_configuration_hash: string | null;
  source_hash: string | null;
  verification_context_hash: string | null;
  execution_context_hash: string | null;
  proposal: CoordinationProposal | null;
  error: string | null;
  failure_stage: string | null;
  current: boolean | null;
  adoptable: boolean;
  adoption_reason: string | null;
  adopted_run_id: string | null;
  adopted_at: string | null;
  answer?: { event_id: string; choice: string; answered_at: string; completion_event_id: string; revoked_at?: string; revocation_event_id?: string } | null;
  answer_revocable?: boolean;
  answerable?: boolean;
  answer_reason?: string | null;
}
export const AdoptCoordinationInputSchema = z.strictObject({});

// ---------------------------------------------------------------------------
// 审批（人工 gate）
// ---------------------------------------------------------------------------

export interface ApprovalItem {
  /** ADR-0030：gate.waiting 事件 ULID，流程和节点从事件事实投影 */
  approval_id: string;
  req_id: string;
  workflow_id: string;
  workflow_revision: string | null;
  node_id: string;
  gate_id: string;
  kind: "human_confirm" | "escalation";
  question: string;
  options: string[];
  reason: string;
  since: string;
}

export const DecideApprovalInputSchema = z.object({
  /** 必须是审批所给选项之一（原文） */
  choice: z.string().min(1),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalInputSchema>;

// ---------------------------------------------------------------------------
// 投票 / 事件
// ---------------------------------------------------------------------------

export interface VoteSummary {
  vote_id: string;
  decision: string;
  entry_id: string | null;
  anchor_overlap: number | null;
  at: string;
}

/** SSE 推送的事件即核心 EventEnvelope 的 JSON 形态（此处仅定义客户端消费所需的字段） */
export interface StreamedEvent {
  event_id: string;
  session_id: string;
  seq: number;
  prev_event_hash: string | null;
  type: string;
  schema_version: "1";
  timestamp: string;
  actor: { kind: "human" | "agent" | "system"; id: string };
  correlation_id: string | null;
  payload: unknown;
  source: { adapter: string };
}

// ---------------------------------------------------------------------------
// SDLC
// ---------------------------------------------------------------------------

export interface SdlcVersionInfo {
  version: number;
  status: "published" | "archived";
  content_hash: string;
  published_at: string;
}

export interface SdlcSummary {
  sdlc_id: string;
  name: string;
  builtin: boolean;
  has_draft: boolean;
  versions: SdlcVersionInfo[];
}

export const ValidateSdlcInputSchema = z.object({
  yaml: z.string().min(1).max(500_000),
});
export type ValidateSdlcInput = z.infer<typeof ValidateSdlcInputSchema>;

export interface SdlcValidationResult {
  ok: boolean;
  issues: string[];
  content_hash: string | null;
}

export const PublishSdlcInputSchema = z.object({
  yaml: z.string().min(1).max(500_000),
});
export type PublishSdlcInput = z.infer<typeof PublishSdlcInputSchema>;

/** 草稿保存：与发布同形（草稿允许校验不通过，差异在语义而非结构） */
export const SaveDraftInputSchema = PublishSdlcInputSchema;
export type SaveDraftInput = z.infer<typeof SaveDraftInputSchema>;

/** 内置模板（ADR-0014 注意点 9）：发布前的起点，载入后可自由修改 */
export interface SdlcTemplate {
  id: string;
  name: string;
  description: string;
  yaml: string;
}

// ---------------------------------------------------------------------------
// 健康 / doctor
// ---------------------------------------------------------------------------

export interface HealthView {
  ok: boolean;
  service: string;
  version: string;
  uptime_seconds: number;
  cord_root: string;
}

export interface DoctorCheckView {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorView {
  ok: boolean;
  checks: DoctorCheckView[];
  sessions: string[];
  fixed: string[];
}

// ---------------------------------------------------------------------------
// Dashboard 汇总
// ---------------------------------------------------------------------------

export interface DashboardView {
  requirements: { total: number; by_status: Record<RequirementStatus, number> };
  pending_approvals: ApprovalItem[];
  failed_runs: RunInfo[];
  doctor_ok: boolean | null;
}
