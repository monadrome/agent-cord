/**
 * 运行服务（ADR-0021 决策 5/6）：进程内 runner + 人工 gate 桥。
 *
 * - 每个需求同一时刻至多一个在途 run（重复启动 409）；接口按可替换为持久队列设计；
 * - HumanGate 端口实现为「挂起 promise」：gate.waiting 事件是审批的事实来源，
 *   REST 决策先写 human.decision.recorded 事件、再唤醒挂起的执行器；
 * - server 重启后无在途执行器：决策进入 decided 暂存，恢复执行时执行器重新提问即消费；
 * - 恢复 = 执行器节点级扫点重放（ADR-0018 注意点 4），不产生重复节点事件。
 */
import { ulid } from "ulid";
import {
  createExecutor,
  type Anchor,
  type EventEnvelope,
  type HumanGate,
  type SessionHandle,
  type WorkflowDef,
} from "agent-cord";
import type { RunInfo, RunStatus } from "../contracts.js";
import { conflict, notFound } from "../errors.js";
import { runRowToInfo, type IndexStore, type RunRow } from "./index-store.js";
import { decodeApprovalId, scanPendingApprovals, type SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";

interface PendingAsk {
  req_id: string;
  node_id: string;
  gate_id: string;
  question: string;
  options: string[];
  resolve: (choice: string) => void;
}

interface ActiveRun {
  run_id: string;
  req_id: string;
  promise: Promise<void>;
}

function askKey(nodeId: string, gateId: string): string {
  return `${nodeId}/${gateId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class RunService {
  private readonly sessions: SessionService;
  private readonly sdlcs: SdlcService;
  private readonly index: IndexStore;
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /** 无在途执行器时的人工决策暂存：恢复执行器重新提问时优先消费 */
  private readonly decided = new Map<string, string>();

  constructor(sessions: SessionService, sdlcs: SdlcService, index: IndexStore) {
    this.sessions = sessions;
    this.sdlcs = sdlcs;
    this.index = index;
  }

  isActive(reqId: string): boolean {
    return this.active.has(reqId);
  }

  activeRunId(reqId: string): string | null {
    return this.active.get(reqId)?.run_id ?? null;
  }

  /** 启动（或恢复）某需求的 run；绑定具体 SDLC 版本（ADR-0022 决策 4） */
  async start(reqId: string, sdlcId?: string, sdlcVersion?: number): Promise<RunInfo> {
    if (this.active.has(reqId)) {
      throw conflict(`需求 ${reqId} 已有在途 run（${this.active.get(reqId)?.run_id}），等待其结束或人工处理`);
    }
    // 预留槽位必须发生在首个 await 之前，否则并发请求都可能通过检查。
    const reservedRunId = ulid();
    this.active.set(reqId, { run_id: reservedRunId, req_id: reqId, promise: Promise.resolve() });
    try {
      const session = await this.sessions.open(reqId);
      const versioned = await this.sdlcs.get(sdlcId ?? DEFAULT_SDLC_ID, sdlcVersion);
      const run: RunRow = {
        run_id: reservedRunId,
        req_id: reqId,
        sdlc_id: versioned.sdlc_id,
        sdlc_version: versioned.version,
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
      };
      this.index.insertRun(run);
      this.launch(session, run, versioned.def);
      return runRowToInfo(run);
    } catch (error) {
      if (this.active.get(reqId)?.run_id === reservedRunId) this.active.delete(reqId);
      throw error;
    }
  }

  /**
   * 人工 gate 决策：先写 human.decision.recorded 事件（ADR-0012），再唤醒/暂存。
   * 返回写入的事件 id。
   */
  async decide(reqId: string, approvalId: string, choice: string): Promise<{ event_id: string }> {
    const key = decodeApprovalId(approvalId);
    if (key === null) throw notFound(`非法的 approval_id：${approvalId}`);
    const session = await this.sessions.open(reqId);
    const events = await session.events.readOrdered();
    const waiting = scanPendingApprovals(events).get(askKey(key.node_id, key.gate_id));
    if (waiting === undefined) {
      throw notFound(`审批不存在或已处理：${key.node_id}/${key.gate_id}`);
    }
    if (waiting.options.length > 0 && !waiting.options.includes(choice)) {
      throw conflict(`选项不在审批给出的范围内：${JSON.stringify(choice)}（可选：${waiting.options.join(" / ")}）`);
    }

    const event = await session.events.append({
      event_id: ulid(),
      session_id: reqId,
      type: "human.decision.recorded",
      schema_version: "1",
      actor: { kind: "human", id: "local-human" },
      correlation_id: key.node_id,
      payload: {
        question: waiting.question,
        options: waiting.options,
        chosen: choice,
        chosen_index: Math.max(0, waiting.options.indexOf(choice)),
        timeout_ms: null,
        default_index: 0,
        fallback: null,
        raw_input: null,
      },
      source: { adapter: "console-server" },
    });

    const fullKey = `${reqId}:${askKey(key.node_id, key.gate_id)}`;
    const pending = this.pendingAsks.get(fullKey);
    if (pending !== undefined) {
      this.pendingAsks.delete(fullKey);
      pending.resolve(choice);
    } else {
      // 无在途执行器（如 server 重启后）：暂存决策并恢复 run，执行器重新提问即消费
      this.decided.set(fullKey, choice);
      if (!this.active.has(reqId)) {
        const latest = this.index.latestRun(reqId);
        await this.start(reqId, latest?.sdlc_id, latest?.sdlc_version);
      }
    }
    return { event_id: event.event_id };
  }

  /** 启动时恢复：登记为 running 但进程已死的 run，按事件流投影修正或续跑（ADR-0021 注意点 4） */
  async recover(): Promise<string[]> {
    const resumed: string[] = [];
    for (const run of this.index.listRuns()) {
      if (run.status !== "running") continue;
      let versioned;
      try {
        versioned = await this.sdlcs.get(run.sdlc_id, run.sdlc_version);
      } catch {
        this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "绑定的 SDLC 版本已不存在");
        continue;
      }
      const session = await this.sessions.open(run.req_id);
      const events = await session.events.readOrdered();
      const finalStatus = this.computeFinalStatus(events, versioned.def);
      if (finalStatus !== null) {
        this.index.finishRun(run.run_id, finalStatus, new Date().toISOString(), null);
        continue;
      }
      this.launch(session, run, versioned.def);
      resumed.push(`${run.req_id}(${run.run_id})`);
    }
    return resumed;
  }

  /** 终态登记：索引是派生簿记，关闭后（进程退出窗口）登记失败不影响事件流事实 */
  private safeFinish(runId: string, status: RunStatus, error: string | null): void {
    try {
      this.index.finishRun(runId, status, new Date().toISOString(), error);
    } catch {
      // 索引已关闭：runs 表可由事件流重建，丢弃登记不丢事实
    }
  }

  /** 终态判定：流程完成 / 被 block / 等待人工 之外，run 视为可续跑 */
  private computeFinalStatus(events: readonly EventEnvelope[], def: WorkflowDef): RunStatus | null {
    const pending = scanPendingApprovals(events);
    const workflowId = def.metadata.id;
    const relevant = [...pending.values()].filter((info) => info.workflow_id === workflowId);
    if (relevant.length > 0) return "waiting_human";
    const exited = new Set<string>();
    let stopped = false;
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (payload?.["workflow_id"] !== workflowId) continue;
      if (event.type === "workflow.node.exited" && typeof payload["node_id"] === "string") {
        exited.add(payload["node_id"]);
      } else if (event.type === "gate.resolved" && payload["action"] === "stop") {
        stopped = true;
      } else if (event.type === "workflow.node.entered") {
        stopped = false;
      }
    }
    if (def.spec.nodes.every((node) => exited.has(node.id))) return "completed";
    if (stopped) return "blocked";
    return null;
  }

  /** 在后台推进执行器；结束时按事件流投影登记终态并重建账本 */
  private launch(session: SessionHandle, run: RunRow, def: WorkflowDef): void {
    const humanGate = this.createHumanGate(session);
    const executor = createExecutor({
      humanGate,
      payloadFor: (node) => ({ anchors: nodeAnchors(session.req_id, node.artifact) }),
    });
    const promise = executor
      .run(def, session)
      .then(async () => {
        const events = await session.events.readOrdered();
        const status = this.computeFinalStatus(events, def) ?? "completed";
        this.safeFinish(run.run_id, status, null);
        await session.rebuildLedger();
      })
      .catch((error: unknown) => {
        this.safeFinish(run.run_id, "failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.active.delete(session.req_id);
      });
    this.active.set(session.req_id, { run_id: run.run_id, req_id: session.req_id, promise });
  }

  /**
   * HumanGate 桥：执行器先落 gate.waiting 事件再调 ask —— ask 时扫事件流找到
   * 当前未决 gate 作为定位键；有暂存决策立即消费，否则挂起 promise 等 REST 决策。
   */
  private createHumanGate(session: SessionHandle): HumanGate {
    return {
      ask: async (question: string, options: string[]): Promise<string> => {
        const events = await session.events.readOrdered();
        const pending = scanPendingApprovals(events);
        const current = [...pending.values()].find((info) => info.question === question) ??
          [...pending.values()][pending.size - 1];
        if (current === undefined) {
          throw new Error(`gate.waiting 事件缺失，无法定位审批（question=${question}）`);
        }
        const fullKey = `${session.req_id}:${askKey(current.node_id, current.gate_id)}`;
        const predecided = this.decided.get(fullKey);
        if (predecided !== undefined) {
          this.decided.delete(fullKey);
          return predecided;
        }
        return new Promise<string>((resolve) => {
          this.pendingAsks.set(fullKey, {
            req_id: session.req_id,
            node_id: current.node_id,
            gate_id: current.gate_id,
            question,
            options,
            resolve,
          });
        });
      },
    };
  }

  async getRun(runId: string): Promise<RunInfo> {
    const row = this.index.getRun(runId);
    if (row === null) throw notFound(`run 不存在：${runId}`);
    return runRowToInfo(row);
  }

  listRuns(reqId?: string): RunInfo[] {
    return this.index.listRuns(reqId).map(runRowToInfo);
  }
}

/** 节点证据锚点：优先节点产物文档，否则需求 PRD（anchors-present 的事实来源） */
function nodeAnchors(reqId: string, artifact: string | undefined): Anchor[] {
  const doc = artifact ?? "prd.md";
  return [{ kind: "doc", anchor: `cord/${reqId}/${doc}` }];
}
