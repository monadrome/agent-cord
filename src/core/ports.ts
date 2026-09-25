/**
 * agent-cord 模块间接口（唯一权威）。与 schema.ts 配套，修改须经 ADR。
 * 依据：ADR-0011/0013/0014/0017/0020。
 */
import type {
  Actor,
  Anchor,
  EventDraft,
  EventEnvelope,
  EventType,
  GateDef,
  GateResult,
  Ledger,
  VoteRecord,
  VoteVerdict,
  WorkflowDef,
} from "./schema.js";

// ---------------------------------------------------------------------------
// core：事件存储（ADR-0020 单写者 + 原子边界 + 因果链）
// ---------------------------------------------------------------------------

export interface EventStore {
  /** 原子追加：分配 seq 与 prev_event_hash、落盘成功才返回。唯一写路径。 */
  append(draft: EventDraft): Promise<EventEnvelope>;
  /** 读取全部事件（文件行序，不保证因果序） */
  readAll(): Promise<EventEnvelope[]>;
  /** 因果链拓扑序为主、(timestamp, event_id) 兜底的全序 */
  readOrdered(): Promise<EventEnvelope[]>;
  /** 订阅（进程内 dispatcher；事件已落盘后才触发） */
  subscribe(handler: (e: EventEnvelope) => void): () => void;
}

/** events.jsonl → ledger.yaml 的确定性纯函数 reducer（ADR-0020 决策 4） */
export interface Reducer {
  readonly version: string;
  reduce(events: readonly EventEnvelope[]): Ledger;
}

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// voting：投票执行器（ADR-0013；判定侧直连模型 API）
// ---------------------------------------------------------------------------

export interface VoteRequest {
  model_id: string;
  temperature: 0;
  system_prompt: string;
  user_prompt: string;
  /** zod schema 的 JSON Schema 形态，供结构化输出约束 */
  response_schema: Record<string, unknown>;
}

export interface VoteResponse {
  parsed_json: unknown;
  raw_text: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  latency_ms: number;
  request_id: string | null;
  /** 实际服务的模型版本（可能与请求不同；必须记录真实值） */
  served_model_id: string;
}

export interface ProviderAdapter {
  readonly provider: string;
  complete(req: VoteRequest): Promise<VoteResponse>;
}

export interface VoteExecutorInput {
  decision_point: {
    id: string;
    question: string;
    options: string[];
    machine_verifiable: boolean;
    context_pack: string;
  };
  /** k 个异构 voter：必须跨 provider 异构（ADR-0007） */
  voters: Array<{ agent_id: string; adapter: ProviderAdapter; model_id: string }>;
  /** 锚点机验器：锚点是否真实指向存在的文件/符号/用例 */
  verify_anchor: (anchor: Anchor) => Promise<boolean>;
}

export interface VoteExecutor {
  run(input: VoteExecutorInput): Promise<VoteRecord>;
}

// ---------------------------------------------------------------------------
// workflow：薄执行器（ADR-0014/0018）
// ---------------------------------------------------------------------------

export interface CheckerContext {
  session_dir: string;
  anchors: Anchor[];
  payload: Record<string, unknown>;
  /**
   * 执行器持有的 session（可选）：checker 由此读账本/事件流，无需被绑到某个 session 实例。
   * 未提供时须退回只依赖 `session_dir` 的读法（如读 `<session_dir>/ledger.yaml`）。
   */
  session?: SessionHandle;
}

export interface Checker {
  readonly name: string;
  check(ctx: CheckerContext): Promise<GateResult>;
}

export interface CheckerRegistry {
  register(checker: Checker): void;
  get(name: string): Checker | undefined;
}

/** 门禁等待人工时由宿主提供的选择题通道（M2: CLI；M3: 飞书） */
export interface HumanGate {
  ask(question: string, options: string[]): Promise<string>;
}

export interface WorkflowExecutor {
  /** 从头执行或按事件流扫点恢复（ADR-0018 注意点 4：恢复单位是节点，节点内副作用幂等） */
  run(def: WorkflowDef, session: SessionHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// session：cord/<req-id>/ 文件夹句柄（ADR-0010 布局）
// ---------------------------------------------------------------------------

export interface SessionHandle {
  readonly req_id: string;
  readonly dir: string;
  readonly events: EventStore;
  readLedger(): Promise<Ledger>;
  /** 重放事件流重建 ledger.yaml（reducer 纯函数） */
  rebuildLedger(): Promise<Ledger>;
  doctor(): Promise<DoctorReport>;
}

// ---------------------------------------------------------------------------
// 适配器：入站归一化（ADR-0012；CLI 与 IM 适配器共用同一形态）
// ---------------------------------------------------------------------------

/**
 * 入站归一化结果：适配器把平台原始输入（一行 stdin / 一条消息）压成这个形状后，
 * 再经 `buildEventDraft` 变成事件；`raw_id` 是幂等键（平台无 message id 时适配器自己生成）。
 */
export interface NormalizedEvent {
  kind: "command" | "message";
  text: string;
  /** kind=command 时的参数（已去掉 `cord` / `/cord` 前缀） */
  argv: string[];
  actor: Actor;
  source: { adapter: string };
  raw_id: string;
}

// ---------------------------------------------------------------------------
// driver：AgentDriver（ADR-0011/0017；生成侧，M2 仅需裸 headless + ACP 占位）
// ---------------------------------------------------------------------------

export interface AgentTask {
  prompt: string;
  cwd: string;
  /** 只读工具白名单等权限参数 */
  readonly?: boolean;
  timeout_ms?: number;
  session_id?: string;
}

export interface AgentEvent {
  type: "text" | "tool_use" | "result" | "error";
  data: unknown;
  /**
   * 会话 id 回执（`resume` 需要）。driver 目前把它一并放进 `data`（见各 driver 的
   * `*EventData`），此字段是统一槽位；未回传时省略或为 null。
   */
  session_id?: string | null;
}

export interface AgentDriver {
  readonly name: string;
  /** 流式事件 + 最终结果文本 */
  run(task: AgentTask): AsyncIterable<AgentEvent>;
  resume(session_id: string, task: AgentTask): AsyncIterable<AgentEvent>;
}
