/**
 * 控制台 API 契约（ADR-0021 决策 7）：REST/SSE 的 DTO 与命令输入的 zod schema。
 * 这是 server 与 console 之间的唯一共享契约，经 `@agent-cord/server/contracts` 导出；
 * 不修改 `src/core/schema.ts`（核心契约冻结边界不变），这里的类型是核心类型的 API 投影。
 */
import { z } from "zod";

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
  active_run: RunInfo | null;
}

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

export type RunStatus = "running" | "waiting_human" | "completed" | "blocked" | "failed";

export interface RunInfo {
  run_id: string;
  req_id: string;
  sdlc_id: string;
  sdlc_version: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
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

// ---------------------------------------------------------------------------
// 审批（人工 gate）
// ---------------------------------------------------------------------------

export interface ApprovalItem {
  /** base64url("<node_id>/<gate_id>")：审批无独立事实，id 是事件流定位键的编码（ADR-0021 注意点 2） */
  approval_id: string;
  req_id: string;
  workflow_id: string;
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
