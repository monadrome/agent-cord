/**
 * 控制台 API 客户端（ADR-0021 决策 7）：console 与 server 之间的唯一通道。
 *
 * - 契约类型一律从 `@agent-cord/server/contracts`（唯一权威）复用，前端不复制 DTO 定义；
 * - 非 2xx 一律抛 ApiClientError，携带 code / message / details，页面据此提示；
 * - 写命令每次「用户动作」生成一个幂等键（同一次动作的重试可传入同一 key 复用）；
 * - 前端不做任何状态机 / reducer 投影：状态、时间线、账本、审批全部取自 server 投影接口；
 * - base URL 可注入（测试直连真实 server），默认 "" 表示走 vite 开发代理。
 */
import type {
  ApprovalItem,
  CreateRequirementInput,
  DashboardView,
  DoctorView,
  HealthView,
  LedgerView,
  RequirementDetail,
  RequirementSummary,
  RunInfo,
  SdlcSummary,
  SdlcValidationResult,
  SnapshotDocName,
  StartRunInput,
  StreamedEvent,
  TimelineView,
  VoteSummary,
} from "@agent-cord/server/contracts";

/** 快照文档名（与契约 SNAPSHOT_DOC_NAMES 同值；按值列举避免前端运行时依赖 server 源码） */
export const SNAPSHOT_DOCS: readonly SnapshotDocName[] = ["prd", "plan", "adr", "findings"];

/** 统一错误：非 2xx 响应（含网络失败，此时 status=0） */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 响应形状（server 在各 DTO 外统一附带 request_id）
// ---------------------------------------------------------------------------

export interface HealthResponse extends HealthView {
  request_id: string;
}

export interface DashboardResponse extends DashboardView {
  request_id: string;
}

export interface DoctorResponse extends DoctorView {
  request_id: string;
}

export interface RequirementsResponse {
  request_id: string;
  requirements: RequirementSummary[];
}

export interface RequirementResponse {
  request_id: string;
  requirement: RequirementDetail;
}

export interface CreateRequirementResponse {
  request_id: string;
  event_id: string;
  requirement: RequirementSummary;
}

export interface LedgerResponse {
  request_id: string;
  projection_version: string;
  ledger: LedgerView;
}

export interface TimelineResponse {
  request_id: string;
  timeline: TimelineView;
}

export interface ApprovalsResponse {
  request_id: string;
  approvals: ApprovalItem[];
}

export interface VotesResponse {
  request_id: string;
  votes: VoteSummary[];
}

export interface EventsResponse {
  request_id: string;
  events: StreamedEvent[];
}

export interface RunResponse {
  request_id: string;
  run: RunInfo;
}

export interface DecideApprovalResponse {
  request_id: string;
  event_id: string;
  decided: boolean;
}

export interface DocResponse {
  request_id: string;
  doc: SnapshotDocName;
  content: string;
}

export interface DocUpdatedResponse {
  request_id: string;
  doc: SnapshotDocName;
  updated: boolean;
}

export interface SdlcsResponse {
  request_id: string;
  sdlcs: SdlcSummary[];
}

export interface SdlcVersionResponse {
  request_id: string;
  sdlc_id: string;
  version: number;
  content_hash: string;
  published_at: string;
  yaml: string;
}

export interface ValidateSdlcResponse {
  request_id: string;
  validation: SdlcValidationResult;
}

export interface PublishSdlcResponse {
  request_id: string;
  sdlc_id: string;
  version: number;
  content_hash: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** 每次用户动作一个新键；失败重试可复用调用方传入的 key */
function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function writeInit(method: "POST" | "PUT", payload: unknown, key?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key ?? newIdempotencyKey(),
    },
    body: JSON.stringify(payload),
  };
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, path), init);
  } catch (cause) {
    throw new ApiClientError(
      0,
      "network_error",
      `无法连接 server：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = asRecord(body);
    throw new ApiClientError(
      response.status,
      asText(error?.["code"]) ?? `http_${response.status}`,
      asText(error?.["message"]) ?? `请求失败（HTTP ${response.status}）`,
      error?.["details"] ?? null,
    );
  }
  return body as T;
}

const reqPath = (reqId: string): string => `/api/v1/requirements/${encodeURIComponent(reqId)}`;
const docPath = (reqId: string, doc: SnapshotDocName): string => `${reqPath(reqId)}/docs/${doc}`;
const decidePath = (reqId: string, approvalId: string): string =>
  `${reqPath(reqId)}/approvals/${encodeURIComponent(approvalId)}/decide`;
const sdlcPath = (sdlcId: string): string => `/api/v1/sdlcs/${encodeURIComponent(sdlcId)}`;

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface ApiClient {
  health(): Promise<HealthResponse>;
  doctor(): Promise<DoctorResponse>;
  dashboard(): Promise<DashboardResponse>;

  listRequirements(): Promise<RequirementsResponse>;
  getRequirement(reqId: string): Promise<RequirementResponse>;
  createRequirement(input: CreateRequirementInput, key?: string): Promise<CreateRequirementResponse>;

  getLedger(reqId: string): Promise<LedgerResponse>;
  getTimeline(reqId: string): Promise<TimelineResponse>;
  getApprovals(reqId: string): Promise<ApprovalsResponse>;
  getVotes(reqId: string): Promise<VotesResponse>;
  getEvents(reqId: string, afterSeq?: number): Promise<EventsResponse>;
  /** SSE 订阅：返回关闭函数；node 环境无 EventSource 时通过 onError 显式报错，不静默降级 */
  subscribeEvents(reqId: string, onEvent: (event: StreamedEvent) => void, onError?: (error: unknown) => void): () => void;

  startRun(reqId: string, input?: StartRunInput, key?: string): Promise<RunResponse>;
  decideApproval(
    reqId: string,
    approvalId: string,
    choice: string,
    key?: string,
  ): Promise<DecideApprovalResponse>;

  readDoc(reqId: string, doc: SnapshotDocName): Promise<DocResponse>;
  writeDoc(reqId: string, doc: SnapshotDocName, content: string, key?: string): Promise<DocUpdatedResponse>;

  listSdlcs(): Promise<SdlcsResponse>;
  getSdlcVersion(sdlcId: string, version: number): Promise<SdlcVersionResponse>;
  validateSdlc(sdlcId: string, yaml: string): Promise<ValidateSdlcResponse>;
  publishSdlc(sdlcId: string, yaml: string, key?: string): Promise<PublishSdlcResponse>;
}

export function createClient(baseUrl = ""): ApiClient {
  return {
    health: () => request<HealthResponse>(baseUrl, "/api/v1/health"),
    doctor: () => request<DoctorResponse>(baseUrl, "/api/v1/doctor", { method: "POST" }),
    dashboard: () => request<DashboardResponse>(baseUrl, "/api/v1/dashboard"),

    listRequirements: () => request<RequirementsResponse>(baseUrl, "/api/v1/requirements"),
    getRequirement: (reqId) => request<RequirementResponse>(baseUrl, reqPath(reqId)),
    createRequirement: (input, key) =>
      request<CreateRequirementResponse>(baseUrl, "/api/v1/requirements", writeInit("POST", input, key)),

    getLedger: (reqId) => request<LedgerResponse>(baseUrl, `${reqPath(reqId)}/ledger`),
    getTimeline: (reqId) => request<TimelineResponse>(baseUrl, `${reqPath(reqId)}/timeline`),
    getApprovals: (reqId) => request<ApprovalsResponse>(baseUrl, `${reqPath(reqId)}/approvals`),
    getVotes: (reqId) => request<VotesResponse>(baseUrl, `${reqPath(reqId)}/votes`),
    getEvents: (reqId, afterSeq) =>
      request<EventsResponse>(
        baseUrl,
        afterSeq === undefined ? `${reqPath(reqId)}/events` : `${reqPath(reqId)}/events?after_seq=${afterSeq}`,
      ),
    subscribeEvents: (reqId, onEvent, onError) =>
      subscribeEvents(reqId, onEvent, onError, baseUrl),

    startRun: (reqId, input = {}, key) =>
      request<RunResponse>(baseUrl, `${reqPath(reqId)}/runs`, writeInit("POST", input, key)),
    decideApproval: (reqId, approvalId, choice, key) =>
      request<DecideApprovalResponse>(baseUrl, decidePath(reqId, approvalId), writeInit("POST", { choice }, key)),

    readDoc: (reqId, doc) => request<DocResponse>(baseUrl, docPath(reqId, doc)),
    writeDoc: (reqId, doc, content, key) =>
      request<DocUpdatedResponse>(baseUrl, docPath(reqId, doc), writeInit("PUT", { content }, key)),

    listSdlcs: () => request<SdlcsResponse>(baseUrl, "/api/v1/sdlcs"),
    getSdlcVersion: (sdlcId, version) =>
      request<SdlcVersionResponse>(baseUrl, `${sdlcPath(sdlcId)}/versions/${version}`),
    validateSdlc: (sdlcId, yaml) =>
      request<ValidateSdlcResponse>(baseUrl, `${sdlcPath(sdlcId)}/versions/validate`, writeInit("POST", { yaml })),
    publishSdlc: (sdlcId, yaml, key) =>
      request<PublishSdlcResponse>(baseUrl, `${sdlcPath(sdlcId)}/versions/publish`, writeInit("POST", { yaml }, key)),
  };
}

/**
 * SSE 订阅封装（ADR-0021 决策 2）：id 是事件流 seq，断线由浏览器 Last-Event-ID 自动续传。
 * 全局 EventSource 只在调用时读取（node 测试环境不存在，import 即炸是必须避免的）。
 */
export function subscribeEvents(
  reqId: string,
  onEvent: (event: StreamedEvent) => void,
  onError?: (error: unknown) => void,
  baseUrl = "",
): () => void {
  const Ctor = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (typeof Ctor !== "function") {
    onError?.(new Error("当前环境不支持 EventSource，无法订阅实时事件"));
    return () => undefined;
  }
  const source = new Ctor(joinUrl(baseUrl, `${reqPath(reqId)}/events/stream`));
  source.addEventListener("message", (event) => {
    const raw = (event as MessageEvent<string>).data;
    try {
      onEvent(JSON.parse(raw) as StreamedEvent);
    } catch (cause) {
      onError?.(cause);
    }
  });
  source.addEventListener("error", (event) => {
    onError?.(event);
  });
  return () => {
    source.close();
  };
}

/** 默认客户端：base "" 走 vite 开发代理（生产由 server 同源托管静态产物） */
export const api: ApiClient = createClient();
