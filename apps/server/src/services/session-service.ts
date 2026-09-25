/**
 * Session 服务（ADR-0021 决策 1/3）：`cord/<req-id>/` 文件夹与 API 投影之间的唯一通道。
 * - 写只经 `session.events.append`（单写路径，ADR-0020）；文档写只限快照文档（living 文档允许人编辑）；
 * - 审批 / 时间线 / 需求状态一律从事件流实时派生，不落库（不存在双写漂移）；
 * - SessionHandle 进程内缓存（server 是唯一写者，句柄即订阅源）。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid as newEventUlid } from "ulid";
import {
  initSession,
  openSession,
  type EventEnvelope,
  type Ledger,
  type SessionHandle,
  type WorkflowDef,
} from "agent-cord";
import type {
  ApprovalItem,
  GateState,
  LedgerView,
  RequirementDetail,
  RequirementStatus,
  RequirementSummary,
  SnapshotDocName,
  TimelineNode,
  VoteSummary,
} from "../contracts.js";
import { SNAPSHOT_DOC_NAMES } from "../contracts.js";
import { conflict, notFound } from "../errors.js";

const KNOWLEDGE_DIR = "knowledge";
const SKIP_DIRS = new Set([KNOWLEDGE_DIR, ".index", ".sdlc"]);

function docFileName(doc: SnapshotDocName): string {
  return `${doc}.md`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function gateKey(nodeId: string, gateId: string): string {
  return `${nodeId}/${gateId}`;
}

/** base64url 编码/解码审批定位键（ADR-0021 注意点 2） */
export function encodeApprovalId(nodeId: string, gateId: string): string {
  return Buffer.from(gateKey(nodeId, gateId), "utf8").toString("base64url");
}

export function decodeApprovalId(approvalId: string): { node_id: string; gate_id: string } | null {
  const raw = Buffer.from(approvalId, "base64url").toString("utf8");
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { node_id: raw.slice(0, slash), gate_id: raw.slice(slash + 1) };
}

interface WaitingGateInfo {
  workflow_id: string;
  node_id: string;
  gate_id: string;
  kind: "human_confirm" | "escalation";
  question: string;
  options: string[];
  reason: string;
  since: string;
}

interface GateResolvedInfo {
  result: "pass" | "block" | "warn";
  action: "continue" | "escalate" | "stop";
  reason: string;
  human_confirmed: boolean;
  seq: number;
}

/** 审批投影：未被 gate.resolved 覆盖的 gate.waiting（与执行器扫点同一口径，ADR-0021 决策 5） */
export function scanPendingApprovals(events: readonly EventEnvelope[]): Map<string, WaitingGateInfo> {
  const waiting = new Map<string, WaitingGateInfo>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (payload === null) continue;
    const nodeId = str(payload["node_id"]);
    const gateId = str(payload["gate_id"]);
    if (nodeId === null || gateId === null) continue;
    const key = gateKey(nodeId, gateId);
    if (event.type === "gate.waiting") {
      const rawOptions = Array.isArray(payload["options"]) ? payload["options"] : [];
      waiting.set(key, {
        workflow_id: str(payload["workflow_id"]) ?? "",
        node_id: nodeId,
        gate_id: gateId,
        kind: payload["kind"] === "human_confirm" ? "human_confirm" : "escalation",
        question: str(payload["question"]) ?? `门禁 ${gateId} 等待人工裁决`,
        options: rawOptions.filter((o): o is string => typeof o === "string"),
        reason: str(payload["reason"]) ?? "",
        since: event.timestamp,
      });
    } else if (event.type === "gate.resolved") {
      waiting.delete(key);
    }
  }
  return waiting;
}

export class SessionService {
  readonly cordRoot: string;
  private readonly handles = new Map<string, Promise<SessionHandle>>();

  constructor(root: string) {
    this.cordRoot = join(root, "cord");
  }

  /** 确保 cord/ 根存在（幂等；完整 init 仍归 `cord init` / runInit） */
  async ensureRoot(): Promise<void> {
    await mkdir(this.cordRoot, { recursive: true });
  }

  /** 打开（并缓存）session 句柄；不存在 → 404 */
  async open(reqId: string): Promise<SessionHandle> {
    const cached = this.handles.get(reqId);
    if (cached !== undefined) return cached;
    const opening = openSession(this.cordRoot, reqId).catch((error: unknown) => {
      this.handles.delete(reqId);
      throw notFound(`需求不存在：${reqId}`, error instanceof Error ? error.message : String(error));
    });
    this.handles.set(reqId, opening);
    return opening;
  }

  /** 创建需求：initSession + session.created 事件（标题入账，供列表投影） */
  async create(reqId: string, title: string, prd?: string): Promise<{ handle: SessionHandle; event_id: string }> {
    if (await this.exists(reqId)) throw conflict(`需求已存在：${reqId}`);
    const handle = await initSession(this.cordRoot, reqId);
    const event = await handle.events.append({
      event_id: newEventUlid(),
      session_id: reqId,
      type: "session.created",
      schema_version: "1",
      actor: { kind: "human", id: "local-human" },
      correlation_id: null,
      payload: { req_id: reqId, title },
      source: { adapter: "console-server" },
    });
    if (prd !== undefined && prd.trim().length > 0) {
      await this.writeDoc(reqId, "prd", prd);
    }
    // 落账后立刻重投影，保证 ledger.yaml 与事件流一致（doctor 不对新建需求误报漂移）
    await handle.rebuildLedger();
    this.handles.set(reqId, Promise.resolve(handle));
    return { handle, event_id: event.event_id };
  }

  async exists(reqId: string): Promise<boolean> {
    try {
      await readFile(join(this.cordRoot, reqId, "events.jsonl"), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async listIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.cordRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  }

  /** 需求摘要：状态/当前节点从事件流投影（def 用于完成态判定；activeRun 由 run 服务给出） */
  async summarize(reqId: string, activeRun: boolean, def: WorkflowDef | null): Promise<RequirementSummary> {
    const handle = await this.open(reqId);
    const events = await handle.events.readOrdered();
    const pending = scanPendingApprovals(events);
    const last = events[events.length - 1];
    const created = events.find((event) => event.type === "session.created");
    const title = str(asRecord(created?.payload)?.["title"]) ?? reqId;
    return {
      req_id: reqId,
      title,
      created_at: created?.timestamp ?? null,
      event_count: events.length,
      status: computeStatus(events, pending.size, activeRun, def),
      current_node: computeCurrentNode(events),
      pending_approvals: pending.size,
      last_event_at: last?.timestamp ?? null,
    };
  }

  async detail(reqId: string, activeRun: boolean, def: WorkflowDef | null): Promise<RequirementDetail> {
    const summary = await this.summarize(reqId, activeRun, def);
    const docs = {} as Record<SnapshotDocName, boolean>;
    for (const doc of SNAPSHOT_DOC_NAMES) {
      try {
        await readFile(join(this.cordRoot, reqId, docFileName(doc)), "utf8");
        docs[doc] = true;
      } catch {
        docs[doc] = false;
      }
    }
    return { ...summary, docs, active_run: null };
  }

  async readDoc(reqId: string, doc: SnapshotDocName): Promise<string> {
    await this.open(reqId);
    try {
      return await readFile(join(this.cordRoot, reqId, docFileName(doc)), "utf8");
    } catch {
      throw notFound(`文档不存在：${reqId}/${docFileName(doc)}`);
    }
  }

  /** 快照文档是 living 文档（ADR-0010 决策 5）：允许人编辑，状态机流转只经事件流 */
  async writeDoc(reqId: string, doc: SnapshotDocName, content: string): Promise<void> {
    await this.open(reqId);
    await writeFile(join(this.cordRoot, reqId, docFileName(doc)), content, "utf8");
  }

  /** 账本：读取前经 rebuildLedger 重投影（唯一重建路径，ADR-0020 决策 4），保证与事件流一致 */
  async readLedger(reqId: string): Promise<Ledger> {
    const handle = await this.open(reqId);
    return handle.rebuildLedger();
  }

  async readEvents(reqId: string, afterSeq?: number): Promise<EventEnvelope[]> {
    const handle = await this.open(reqId);
    const events = await handle.events.readOrdered();
    return afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq);
  }

  /** 审批列表：事件流投影 + approval_id 编码 */
  async listApprovals(reqId: string): Promise<ApprovalItem[]> {
    const handle = await this.open(reqId);
    const pending = scanPendingApprovals(await handle.events.readOrdered());
    return [...pending.values()].map((info) => ({
      approval_id: encodeApprovalId(info.node_id, info.gate_id),
      req_id: reqId,
      workflow_id: info.workflow_id,
      node_id: info.node_id,
      gate_id: info.gate_id,
      kind: info.kind,
      question: info.question,
      options: info.options,
      reason: info.reason,
      since: info.since,
    }));
  }

  /** 投票记录：vote.completed 事件的投影 */
  async listVotes(reqId: string): Promise<VoteSummary[]> {
    const handle = await this.open(reqId);
    const votes: VoteSummary[] = [];
    for (const event of await handle.events.readOrdered()) {
      if (event.type !== "vote.completed") continue;
      const payload = asRecord(event.payload) ?? {};
      votes.push({
        vote_id: str(payload["vote_id"]) ?? "",
        decision: str(payload["decision"]) ?? "",
        entry_id: str(payload["entry_id"]),
        anchor_overlap: typeof payload["anchor_overlap"] === "number" ? payload["anchor_overlap"] : null,
        at: event.timestamp,
      });
    }
    return votes;
  }

  /** 工作流时间线：以 def 为骨架，用事件流填状态（前端不复制这份状态机） */
  async timeline(reqId: string, def: WorkflowDef | null): Promise<TimelineNode[]> {
    const handle = await this.open(reqId);
    const events = await handle.events.readOrdered();
    const workflowId = def?.metadata.id ?? "";
    const pending = scanPendingApprovals(events);
    const resolved = new Map<string, GateResolvedInfo>();
    const enteredAt = new Map<string, string>();
    const exitedAt = new Map<string, string>();

    for (const event of events) {
      const payload = asRecord(event.payload);
      if (payload === null || payload["workflow_id"] !== workflowId) continue;
      const nodeId = str(payload["node_id"]);
      if (nodeId === null) continue;
      if (event.type === "workflow.node.entered") {
        if (!enteredAt.has(nodeId)) enteredAt.set(nodeId, event.timestamp);
      } else if (event.type === "workflow.node.exited") {
        exitedAt.set(nodeId, event.timestamp);
      } else if (event.type === "gate.resolved") {
        const gateId = str(payload["gate_id"]);
        if (gateId === null) continue;
        const result = payload["result"];
        const action = payload["action"];
        resolved.set(gateKey(nodeId, gateId), {
          result: result === "pass" || result === "warn" || result === "block" ? result : "block",
          action: action === "continue" || action === "escalate" ? action : "stop",
          reason: str(payload["reason"]) ?? "",
          human_confirmed: payload["human_confirmed"] === true,
          seq: event.seq,
        });
      }
    }

    if (def === null) return [];
    return def.spec.nodes.map((node) => {
      const gates: GateState[] = node.gates.map((gate) => {
        const key = gateKey(node.id, gate.id);
        const done = resolved.get(key);
        return {
          gate_id: gate.id,
          phase: gate.attach.when,
          waiting: pending.has(key),
          result: done?.result ?? null,
          action: done?.action ?? null,
          reason: done?.reason ?? null,
          human_confirmed: done?.human_confirmed ?? false,
        };
      });
      return {
        node_id: node.id,
        artifact: node.artifact ?? null,
        depends_on: node.depends_on,
        status: exitedAt.has(node.id) ? "exited" : enteredAt.has(node.id) ? "entered" : "pending",
        entered_at: enteredAt.get(node.id) ?? null,
        exited_at: exitedAt.get(node.id) ?? null,
        gates,
      };
    });
  }

  /** 工作流是否全部节点退出（用于 run 终态判定） */
  async workflowCompleted(reqId: string, def: WorkflowDef): Promise<boolean> {
    const nodes = await this.timeline(reqId, def);
    return nodes.length > 0 && nodes.every((node) => node.status === "exited");
  }
}

function computeStatus(
  events: readonly EventEnvelope[],
  pendingApprovals: number,
  activeRun: boolean,
  def: WorkflowDef | null,
): RequirementStatus {
  if (pendingApprovals > 0) return "waiting_human";
  if (activeRun) return "running";
  const hasWorkflow = events.some((event) => event.type === "workflow.node.entered");
  if (!hasWorkflow) return "idle";
  const lastResolved = [...events].reverse().find((event) => event.type === "gate.resolved");
  const lastExited = [...events].reverse().find((event) => event.type === "workflow.node.exited");
  if (
    lastResolved !== undefined &&
    asRecord(lastResolved.payload)?.["action"] === "stop" &&
    (lastExited === undefined || lastExited.seq < lastResolved.seq)
  ) {
    return "blocked";
  }
  if (def !== null) {
    const workflowId = def.metadata.id;
    const exited = new Set<string>();
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (event.type === "workflow.node.exited" && payload?.["workflow_id"] === workflowId) {
        const nodeId = payload["node_id"];
        if (typeof nodeId === "string") exited.add(nodeId);
      }
    }
    if (def.spec.nodes.every((node) => exited.has(node.id))) return "completed";
  }
  return "running";
}

function computeCurrentNode(events: readonly EventEnvelope[]): string | null {
  const entered = new Set<string>();
  const exited = new Set<string>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const nodeId = payload?.["node_id"];
    if (typeof nodeId !== "string") continue;
    if (event.type === "workflow.node.entered") entered.add(nodeId);
    else if (event.type === "workflow.node.exited") exited.add(nodeId);
  }
  for (const nodeId of entered) {
    if (!exited.has(nodeId)) return nodeId;
  }
  return null;
}

/** 账本 → API 投影（core Ledger 结构字段一致，仅做显式映射防止内部类型泄漏） */
export function toLedgerView(ledger: Ledger): LedgerView {
  return {
    reducer_version: ledger.reducer_version,
    input_hash: ledger.input_hash,
    output_hash: ledger.output_hash,
    entries: ledger.entries.map((entry) => ({
      entry_id: entry.entry_id,
      title: entry.title,
      status: entry.status,
      anchors: entry.anchors.map((anchor) => ({
        kind: anchor.kind,
        anchor: anchor.anchor,
        ...(anchor.snapshot !== undefined ? { snapshot: anchor.snapshot } : {}),
        ...(anchor.line_hint !== undefined ? { line_hint: anchor.line_hint } : {}),
      })),
      confidence_source: entry.confidence_source,
      vote_record_id: entry.vote_record_id,
      superseded_by: entry.superseded_by,
      overturn_reason: entry.overturn_reason,
      conflict: entry.conflict,
    })),
  };
}
