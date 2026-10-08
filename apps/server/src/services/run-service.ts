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
  createNodeRunner,
  createBuiltinRegistry,
  evaluateGate,
  readApprovalContextHash,
  canonicalJson,
  sha256Hex,
  CoordinatorRoundAdoptedPayloadSchema,
  CoordinatorRoundRequestedPayloadSchema,
  WorkflowRunStartedPayloadSchema,
  VerificationCompletedPayloadSchema,
  matchesWorkflowScope,
  type AgentDriver,
  type Anchor,
  type EventEnvelope,
  type GateDef,
  type HumanGate,
  type HumanGateAnswer,
  type SessionHandle,
  type WorkflowDef,
} from "agent-cord";
import type { RunInfo, RunStatus } from "../contracts.js";
import { conflict, notFound } from "../errors.js";
import { runRowToInfo, type IndexStore, type RunRow } from "./index-store.js";
import { decodeApprovalId, scanPendingApprovals, type SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";
import { readVerificationSource, verificationSourceInputs, VerificationInputError } from "./verification-inputs.js";

interface PendingAsk {
  req_id: string;
  run_id: string;
  node_id: string;
  gate_id: string;
  question: string;
  options: string[];
  waiting_event_id: string;
  verification_ids: string[];
  resolve: (choice: HumanGateAnswer) => void;
}

interface ActiveRun {
  run_id: string;
  req_id: string;
  promise: Promise<void>;
  /** run 取消（ADR-0025）：abort → 执行器节点边界止步 + 人工挂起唤醒 + agent 子进程收束 */
  controller: AbortController;
  driverResolver?: (name: string) => AgentDriver;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunServiceOptions {
  /** 驱动解析叠加层（agents.yaml 优先，退回全局 registry）；缺省时 node.run 执行体不生效 */
  driverResolver?: (name: string) => AgentDriver;
  /** ADR-0027：每个 run 启动时固定当前配置，重载只影响后续 run */
  driverResolverForRun?: () => (name: string) => AgentDriver;
  /** worker agent 的工作目录（工作区根，即 cord/ 的上级） */
  workspaceRoot?: string;
}

/** ADR-0033：运行槽位内校验人工采用依据，事实落盘成功后才启动执行器。 */
export interface RunStartGuard {
  coordination_round_id: string;
  validate(session: SessionHandle, def: WorkflowDef, workflow_revision: string): Promise<void>;
  record(session: SessionHandle, run_id: string): Promise<void>;
}

export class RunService {
  private readonly sessions: SessionService;
  private readonly sdlcs: SdlcService;
  private readonly index: IndexStore;
  private readonly options: RunServiceOptions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /** 无在途执行器时的人工决策暂存：恢复执行器重新提问时优先消费 */
  private readonly decided = new Map<string, string>();
  private readonly decision_queue = new Map<string, Promise<unknown>>();
  private recovery_queue: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(sessions: SessionService, sdlcs: SdlcService, index: IndexStore, options: RunServiceOptions = {}) {
    this.sessions = sessions;
    this.sdlcs = sdlcs;
    this.index = index;
    this.options = options;
  }

  isActive(reqId: string): boolean {
    return this.active.has(reqId);
  }

  activeRunId(reqId: string): string | null {
    return this.active.get(reqId)?.run_id ?? null;
  }

  /** 关闭仅收束执行体，不改变用户取消/人工决定事实，终态由重启恢复判定。 */
  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort();
    await Promise.all(active.map((run) => run.promise));
    await this.recovery_queue.catch(() => undefined);
  }

  /** 验证事实只唤醒引用它的 gate；重启后的等待恢复原 run，不另建身份。 */
  async recheck(runId: string, node_id: string, verification_id: string): Promise<void> {
    if (this.closing) return;
    const run = this.index.getRun(runId);
    if (run === null) throw notFound(`run 不存在：${runId}`);
    if (!this.active.has(run.req_id)) await this.recover(runId);
    const pending = [...this.pendingAsks.entries()].find(([, ask]) =>
      ask.run_id === runId && ask.node_id === node_id && ask.verification_ids.includes(verification_id),
    );
    if (pending === undefined) return;
    this.pendingAsks.delete(pending[0]);
    pending[1].resolve({ kind: "recheck" });
  }

  /** 取当前 run 固定的 agent 配置身份；verification context 不得读取热重载后的 resolver。 */
  configurationHashFor(reqId: string, agentName: string): string | null {
    const resolver = this.active.get(reqId)?.driverResolver
      ?? this.options.driverResolverForRun?.()
      ?? this.options.driverResolver;
    if (resolver === undefined) return null;
    return resolver(agentName).configuration_hash ?? null;
  }

  /** 验证 context、gate、人工审批与恢复共用同一输入身份。 */
  async readNodeInput(def: WorkflowDef, node: WorkflowDef["spec"]["nodes"][number], session: SessionHandle, configuration_hash: string | null, workflow_revision?: string) {
    const inputs = verificationSourceInputs(node);
    if (inputs.length > 0 && this.options.workspaceRoot === undefined) throw new VerificationInputError("声明源码输入需要验证工作区根目录");
    let source;
    try { source = await readVerificationSource(this.options.workspaceRoot ?? "", inputs); }
    catch (error) {
      if (error instanceof VerificationInputError) throw error;
      throw new VerificationInputError("无法读取声明的验证输入，请检查工作区文件与访问权限");
    }
    const context_hash = await readApprovalContextHash(def, node, session, configuration_hash, workflow_revision);
    const input_hash = source.source_hash === null ? context_hash : sha256Hex(canonicalJson({
      domain: "cord.verification-input.v1", context_hash, ...source,
    }));
    return { input_hash, ...source };
  }

  /** 当前绑定按启动事实的因果顺序确定；没有新协议事实时只读旧操作登记。 */
  async latestRun(req_id: string): Promise<RunRow | null> {
    for (const event of [...await this.sessions.readEvents(req_id)].reverse()) {
      if (event.type !== "workflow.run.started") continue;
      const parsed = WorkflowRunStartedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new Error("工作流启动绑定事件不符合契约");
      const payload = parsed.data;
      const row = this.index.getRun(payload.run_id);
      if (row === null || row.req_id !== req_id || row.sdlc_id !== payload.sdlc_id || row.sdlc_version !== payload.sdlc_version || row.workflow_revision !== payload.workflow_revision) throw new Error("运行登记与启动绑定事实不一致");
      return row;
    }
    return this.index.latestRun(req_id);
  }

  /** 启动（或恢复）某需求的 run；绑定具体 SDLC 版本（ADR-0022 决策 4） */
  async start(reqId: string, sdlcId?: string, sdlcVersion?: number, guard?: RunStartGuard): Promise<RunInfo> {
    if (this.closing) throw conflict("服务正在关闭，不能启动 run");
    if (this.active.has(reqId)) {
      throw conflict(`需求 ${reqId} 已有在途 run（${this.active.get(reqId)?.run_id}），等待其结束或人工处理`);
    }
    // 预留槽位必须发生在首个 await 之前，否则并发请求都可能通过检查。
    const reservedRunId = ulid();
    const controller = new AbortController();
    this.active.set(reqId, { run_id: reservedRunId, req_id: reqId, promise: Promise.resolve(), controller });
    let registered = false;
    try {
      const session = await this.sessions.open(reqId);
      const versioned = await this.sdlcs.get(sdlcId ?? DEFAULT_SDLC_ID, sdlcVersion);
      // ADR-0022：归档版本禁止启动新 run（在途/历史 run 不受影响）
      if (this.sdlcs.isArchived(versioned.sdlc_id, versioned.version)) {
        throw conflict(
          `SDLC "${versioned.sdlc_id}" v${versioned.version} 已归档，禁止启动新 run（可取消归档或选择其他版本）`,
        );
      }
      await guard?.validate(session, versioned.def, versioned.workflow_revision);
      const run: RunRow = {
        run_id: reservedRunId,
        req_id: reqId,
        sdlc_id: versioned.sdlc_id,
        sdlc_version: versioned.version,
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        coordination_round_id: guard?.coordination_round_id ?? null,
        workflow_revision: versioned.workflow_revision,
      };
      this.index.insertRun(run);
      registered = true;
      await session.events.append({ event_id: ulid(), session_id: reqId, type: "workflow.run.started", schema_version: "1",
        actor: { kind: "human", id: "local-human" }, correlation_id: reservedRunId,
        payload: { run_id: reservedRunId, workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, sdlc_id: versioned.sdlc_id, sdlc_version: versioned.version,
          ...(guard !== undefined ? { coordination_round_id: guard.coordination_round_id } : {}) }, source: { adapter: "console-server" } });
      await guard?.record(session, reservedRunId);
      this.launch(session, run, versioned.def, controller);
      return runRowToInfo(run);
    } catch (error) {
      if (registered) this.safeFinish(reservedRunId, "failed", error instanceof Error ? error.message : String(error));
      if (this.active.get(reqId)?.run_id === reservedRunId) this.active.delete(reqId);
      throw error;
    }
  }

  /**
   * 取消 run（ADR-0025）：先落 workflow.run.cancelled 事件（事实），再 abort 在途执行器。
   * 幂等：已终态/已取消的 run 重复取消返回现状，不重复落事件。
   * 无在途执行器（server 重启后）也可以取消：事件落盘 + 直接登记终态。
   */
  async cancel(runId: string, reason?: string): Promise<RunInfo> {
    const row = this.index.getRun(runId);
    if (row === null) throw notFound(`run 不存在：${runId}`);
    if (row.status !== "running" && row.status !== "waiting_human") {
      return runRowToInfo(row);
    }
    const session = await this.sessions.open(row.req_id);
    const events = await session.events.readOrdered();
    const started_payload = events.filter((event) => event.type === "workflow.run.started").map((event) => WorkflowRunStartedPayloadSchema.safeParse(event.payload)).find((item) => item.success && item.data.run_id === row.run_id);
    const workflow_id = started_payload?.success === true ? started_payload.data.workflow_id : (await this.sdlcs.get(row.sdlc_id, row.sdlc_version)).def.metadata.id;
    const scope = { workflow_id, workflow_revision: row.workflow_revision ?? undefined };
    const alreadyCancelled = events.some(
      (event) =>
        event.type === "workflow.run.cancelled" &&
        matchesWorkflowScope(event.payload, scope) &&
        asRecord(event.payload)?.["run_id"] === runId,
    );
    if (!alreadyCancelled) {
      await session.events.append({
        event_id: ulid(),
        session_id: row.req_id,
        type: "workflow.run.cancelled",
        schema_version: "1",
        actor: { kind: "human", id: "local-human" },
        correlation_id: null,
        payload: {
          workflow_id,
          ...(row.workflow_revision != null ? { workflow_revision: row.workflow_revision } : {}),
          run_id: runId,
          ...(reason !== undefined ? { reason } : {}),
        },
        source: { adapter: "console-server" },
      });
    }

    const active = this.active.get(row.req_id);
    if (active?.run_id === runId) {
      // 清掉该需求挂起的审批 promise（ask 侧由 signal 唤醒，这里清引用防滞留）
      for (const [key, pending] of this.pendingAsks) {
        if (pending.req_id === row.req_id) this.pendingAsks.delete(key);
      }
      active.controller.abort();
      // 等执行器收束（节点边界止步 + agent 进程清理），有界等待兜底
      await Promise.race([active.promise.catch(() => undefined), delay(5_000)]);
      const fresh = this.index.getRun(runId);
      if (fresh !== null) return runRowToInfo(fresh);
      return runRowToInfo(row);
    }
    // 无在途执行器：不会有别的写者登记终态，直接登记 cancelled
    this.index.finishRun(runId, "cancelled", new Date().toISOString(), reason ?? null);
    const fresh = this.index.getRun(runId);
    return runRowToInfo(fresh ?? { ...row, status: "cancelled", finished_at: new Date().toISOString(), error: reason ?? null });
  }

  /**
   * 人工 gate 决策：先写 human.decision.recorded 事件（ADR-0012），再唤醒/暂存。
   * 返回写入的事件 id。
   */
  decide(reqId: string, approvalId: string, choice: string): Promise<{ event_id: string }> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭，不能提交人工决定"));
    const prior = this.decision_queue.get(reqId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.decideCurrent(reqId, approvalId, choice));
    this.decision_queue.set(reqId, operation);
    return operation.finally(() => {
      if (this.decision_queue.get(reqId) === operation) this.decision_queue.delete(reqId);
    });
  }

  private async decideCurrent(reqId: string, approvalId: string, choice: string): Promise<{ event_id: string }> {
    const ticket = decodeApprovalId(approvalId);
    if (ticket === null) throw notFound(`非法的 approval_id：${approvalId}`);
    if (ticket.waiting_event_id === undefined) throw conflict("审批缺少等待版本，请读取当前审批后重新确认");
    const session = await this.sessions.open(reqId);
    const events = await session.events.readOrdered();
    const waiting = [...scanPendingApprovals(events).values()].find((info) => info.waiting_event_id === ticket.waiting_event_id);
    if (waiting === undefined) {
      if (events.some((event) => event.type === "gate.waiting" && event.event_id === ticket.waiting_event_id)) {
        throw conflict("该审批已处理或被新版本替代，请确认当前审批");
      }
      throw notFound("审批不存在或已处理");
    }
    const key = { node_id: waiting.node_id, gate_id: waiting.gate_id };
    if (events.some((event) => event.type === "human.decision.recorded" && asRecord(event.payload)?.["waiting_event_id"] === waiting.waiting_event_id)) {
      throw conflict("该审批已有决策，请读取当前审批");
    }
    if (waiting.options.length > 0 && !waiting.options.includes(choice)) {
      throw conflict(`选项不在审批给出的范围内：${JSON.stringify(choice)}（可选：${waiting.options.join(" / ")}）`);
    }

    const active = this.active.get(reqId);
    const latest = active !== undefined ? this.index.getRun(active.run_id) : await this.latestRun(reqId);
    if (latest === null || latest.workflow_revision == null) throw conflict("当前运行缺少可验证的执行版本，请重新启动绑定版本");
    const versioned = await this.sdlcs.get(latest?.sdlc_id ?? waiting.workflow_id, latest?.sdlc_version);
    if (latest.workflow_revision !== versioned.workflow_revision || waiting.workflow_revision !== latest.workflow_revision || versioned.def.metadata.id !== waiting.workflow_id) throw conflict("审批不属于当前执行版本，请确认当前审批");
    const node = versioned.def.spec.nodes.find((item) => item.id === key.node_id);
    const gate = node?.gates.find((item) => item.id === key.gate_id);
    if (node === undefined || gate === undefined) throw conflict("绑定流程中找不到当前审批，拒绝记录决策");
    let current_hash: string;
    try {
      const evaluated = await this.evaluateRunGate(session, latest, versioned.def, node, gate);
      current_hash = evaluated.evaluation_hash;
    } catch {
      throw conflict("无法验证当前审批依据，拒绝记录放行，请先修复输入");
    }
    if (waiting.evaluation_hash !== current_hash) {
      await session.events.append({ event_id: ulid(), session_id: reqId, type: "gate.invalidated", schema_version: "1", actor: { kind: "system", id: "console-server" }, correlation_id: node.id,
        payload: { workflow_id: waiting.workflow_id, workflow_revision: waiting.workflow_revision, node_id: node.id, gate_id: gate.id, waiting_event_id: waiting.waiting_event_id, reason: "审批依据已变化，旧选择不用于当前内容" }, source: { adapter: "console-server" } });
      const stale_key = `${reqId}:${waiting.waiting_event_id}`;
      const pending = this.pendingAsks.get(stale_key);
      this.pendingAsks.delete(stale_key);
      this.decided.delete(stale_key);
      if (pending !== undefined) pending.resolve({ kind: "recheck" });
      else if (!this.active.has(reqId)) await this.start(reqId, versioned.sdlc_id, versioned.version);
      throw conflict("审批依据已变化，已重新检查；请确认当前审批");
    }

    const still_waiting = [...scanPendingApprovals(await session.events.readOrdered()).values()]
      .some((info) => info.waiting_event_id === waiting.waiting_event_id);
    if (!still_waiting) throw conflict("审批在核验期间已取消或更新，请读取当前审批");

    const event = await session.events.append({
      event_id: ulid(),
      session_id: reqId,
      type: "human.decision.recorded",
      schema_version: "1",
      actor: { kind: "human", id: "local-human" },
      correlation_id: key.node_id,
      payload: {
        workflow_id: waiting.workflow_id,
        workflow_revision: waiting.workflow_revision,
        waiting_event_id: waiting.waiting_event_id,
        evaluation_hash: current_hash,
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

    const fullKey = `${reqId}:${waiting.waiting_event_id}`;
    const pending = this.pendingAsks.get(fullKey);
    if (pending !== undefined) {
      this.pendingAsks.delete(fullKey);
      pending.resolve(choice);
    } else {
      // 原 run 的机器证据与审批必须保持同一身份。
      this.decided.set(fullKey, choice);
      if (!this.active.has(reqId)) {
        const latest = await this.latestRun(reqId);
        if (latest !== null) await this.recover(latest.run_id);
      }
    }
    return { event_id: event.event_id };
  }

  /** 启动时恢复：登记为 running 但进程已死的 run，按事件流投影修正或续跑（ADR-0021 注意点 4） */
  recover(run_id?: string): Promise<string[]> {
    if (this.closing) return Promise.resolve([]);
    const operation = this.recovery_queue.catch(() => undefined).then(() => this.recoverCurrent(run_id));
    this.recovery_queue = operation.catch(() => undefined);
    return operation;
  }

  private async recoverCurrent(run_id?: string): Promise<string[]> {
    // 启动绑定是事实；索引可删除，不能因此回退默认 SDLC 或失去当前版本。
    for (const req_id of await this.sessions.listIds()) {
      for (const event of await this.sessions.readEvents(req_id)) {
        if (event.type !== "workflow.run.started") continue;
        const parsed = WorkflowRunStartedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) throw new Error("工作流启动绑定事件不符合契约");
        const payload = parsed.data;
        if (this.index.getRun(payload.run_id) === null) this.index.insertRun({ run_id: payload.run_id, req_id, sdlc_id: payload.sdlc_id, sdlc_version: payload.sdlc_version,
          status: "running", started_at: event.timestamp, finished_at: null, error: null, workflow_revision: payload.workflow_revision, coordination_round_id: payload.coordination_round_id ?? null });
      }
    }
    const resumed: string[] = [];
    for (const run of this.index.listRuns()) {
      if (this.closing) break;
      if (run_id !== undefined && run.run_id !== run_id) continue;
      if (this.active.has(run.req_id)) continue;
      if (run.status !== "running" && run.status !== "waiting_human") continue;
      const session = await this.sessions.open(run.req_id);
      const events = await session.events.readOrdered();
      const started = events.filter((event) => event.type === "workflow.run.started").map((event) => WorkflowRunStartedPayloadSchema.safeParse(event.payload)).find((parsed) =>
        parsed.success && parsed.data.run_id === run.run_id && parsed.data.sdlc_id === run.sdlc_id && parsed.data.sdlc_version === run.sdlc_version && parsed.data.coordination_round_id === (run.coordination_round_id ?? undefined) && parsed.data.workflow_revision === run.workflow_revision);
      if (run.workflow_revision == null) { this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "工作流执行版本缺失，拒绝恢复派发"); continue; }
      if (started?.success !== true) { this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "工作流启动绑定事实缺失，拒绝恢复派发"); continue; }
      const is_current = (await this.latestRun(run.req_id))?.run_id === run.run_id;
      let versioned;
      try {
        versioned = await this.sdlcs.get(run.sdlc_id, run.sdlc_version);
      } catch {
        this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "绑定的 SDLC 版本已不存在");
        continue;
      }
      if (run.workflow_revision !== versioned.workflow_revision) {
        this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "工作流执行版本缺失或发布定义已变化，拒绝恢复派发");
        continue;
      }
      const scope = { workflow_id: versioned.def.metadata.id, workflow_revision: run.workflow_revision };
      if (!matchesWorkflowScope(started.data, scope)) { this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "工作流启动绑定与定义不一致，拒绝恢复派发"); continue; }
      if (run.coordination_round_id != null) {
        const adoption = events.find((event) => {
          if (event.type !== "coordinator.round.adopted") return false;
          const parsed = CoordinatorRoundAdoptedPayloadSchema.safeParse(event.payload);
          return parsed.success && parsed.data.run_id === run.run_id && parsed.data.round_id === run.coordination_round_id && matchesWorkflowScope(parsed.data, scope);
        });
        const request = events.find((event) => {
          if (event.type !== "coordinator.round.requested") return false;
          const parsed = CoordinatorRoundRequestedPayloadSchema.safeParse(event.payload);
          return parsed.success && parsed.data.round_id === run.coordination_round_id && parsed.data.sdlc_id === run.sdlc_id && parsed.data.sdlc_version === run.sdlc_version && matchesWorkflowScope(parsed.data, scope);
        });
        if (adoption === undefined || request === undefined) {
          this.index.finishRun(run.run_id, "failed", new Date().toISOString(), "协调采用事实缺失或版本不匹配，未恢复派发");
          continue;
        }
      }
      const finalStatus = this.computeFinalStatus(events, versioned.def, run.run_id, run.workflow_revision);
      if (this.closing) break;
      const recorded_decision = [...scanPendingApprovals(events, scope).values()].some((waiting) =>
        waiting.workflow_id === versioned.def.metadata.id && events.some((event) =>
          event.type === "human.decision.recorded" && asRecord(event.payload)?.["waiting_event_id"] === waiting.waiting_event_id,
        ),
      );
      let recorded_verification = false;
      let verification_unavailable = false;
      if (is_current) for (const waiting of scanPendingApprovals(events, scope).values()) {
        const node = versioned.def.spec.nodes.find((item) => item.id === waiting.node_id);
        const gate = node?.gates.find((item) => item.id === waiting.gate_id);
        if (node === undefined || gate === undefined) continue;
        const ids = verificationIds(gate);
        const has_result = events.some((event) => {
          if (event.type !== "verification.completed") return false;
          const parsed = VerificationCompletedPayloadSchema.safeParse(event.payload);
          return parsed.success && matchesWorkflowScope(parsed.data, scope) && parsed.data.run_id === run.run_id
            && parsed.data.node_id === node.id && ids.includes(parsed.data.verification_id);
        });
        if (!has_result) continue;
        try {
          const evaluated = await this.evaluateRunGate(session, run, versioned.def, node, gate);
          if (evaluated.evaluation_hash !== waiting.evaluation_hash) {
            recorded_verification = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof VerificationInputError)) throw error;
          verification_unavailable = true;
          break;
        }
      }
      if (!is_current) {
        if (finalStatus !== null) this.index.finishRun(run.run_id, finalStatus, new Date().toISOString(), null);
        continue;
      }
      if (verification_unavailable) {
        this.index.setRunStatus(run.run_id, "waiting_human");
        continue;
      }
      if (run.status === "waiting_human" && !recorded_decision && !recorded_verification) continue;
      if (finalStatus !== null && !(finalStatus === "waiting_human" && (recorded_decision || recorded_verification))) {
        this.index.finishRun(run.run_id, finalStatus, new Date().toISOString(), null);
        continue;
      }
      const latest = await this.latestRun(run.req_id);
      if (latest?.run_id !== run.run_id || (latest.status !== "running" && latest.status !== "waiting_human") || this.active.has(run.req_id)) continue;
      this.launch(session, run, versioned.def, new AbortController());
      resumed.push(`${run.req_id}(${run.run_id})`);
    }
    return resumed;
  }

  /** 终态登记：索引是派生簿记，关闭后（进程退出窗口）登记失败不影响事件流事实 */
  private safeFinish(runId: string, status: RunStatus, error: string | null): void {
    if (this.closing) return;
    try {
      this.index.finishRun(runId, status, new Date().toISOString(), error);
    } catch {
      // 索引已关闭：runs 表可由事件流重建，丢弃登记不丢事实
    }
  }

  /** 终态判定：流程完成 / 被 block / 等待人工 / 执行体失败 / 已取消 之外，run 视为可续跑 */
  private computeFinalStatus(events: readonly EventEnvelope[], def: WorkflowDef, runId: string, workflow_revision?: string): RunStatus | null {
    const scope = { workflow_id: def.metadata.id, workflow_revision };
    const pending = scanPendingApprovals(events, scope);
    const workflowId = def.metadata.id;
    const relevant = [...pending.values()].filter((info) => info.workflow_id === workflowId);
    if (relevant.length > 0) return "waiting_human";
    // ADR-0025：本 run 的取消事件存在且流程未走完 → cancelled（按 run_id 匹配，历史 run 的取消不算数）
    const cancelled = events.some(
      (event) =>
        event.type === "workflow.run.cancelled" &&
        matchesWorkflowScope(event.payload, scope) &&
        asRecord(event.payload)?.["run_id"] === runId,
    );
    const exited = new Set<string>();
    const failedNodes = new Set<string>();
    let stopped = false;
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (!matchesWorkflowScope(payload, scope)) continue;
      const nodeId = payload["node_id"];
      if (event.type === "workflow.node.exited" && typeof nodeId === "string") {
        exited.add(nodeId);
        failedNodes.delete(nodeId);
      } else if (event.type === "agent.task.completed" && typeof nodeId === "string") {
        // ADR-0023：执行体失败 = run failed（重跑同一 run 会重试该节点）；cancelled 不算失败
        const status = payload["status"];
        if (status === "ok") failedNodes.delete(nodeId);
        else if (status === "failed" || status === "timeout") failedNodes.add(nodeId);
      } else if (event.type === "gate.resolved" && payload["action"] === "stop") {
        stopped = true;
      } else if (event.type === "workflow.node.entered") {
        stopped = false;
      }
    }
    if (def.spec.nodes.every((node) => exited.has(node.id))) return "completed";
    if (cancelled) return "cancelled";
    if (failedNodes.size > 0) return "failed";
    if (stopped) return "blocked";
    return null;
  }

  /** 在后台推进执行器；结束时按事件流投影登记终态并重建账本 */
  private launch(session: SessionHandle, run: RunRow, def: WorkflowDef, controller: AbortController): void {
    if (this.closing) return;
    const humanGate = this.createHumanGate(session, run, def);
    const { workspaceRoot } = this.options;
    const driverResolver = this.options.driverResolverForRun?.() ?? this.options.driverResolver;
    const executor = createExecutor({
      run_id: run.run_id,
      workflow_revision: run.workflow_revision ?? undefined,
      humanGate,
      gateInputHash: async (node) => (await this.readNodeInput(def, node, session,
        node.run !== undefined ? driverResolver?.(node.run.agent).configuration_hash ?? null : null, run.workflow_revision ?? undefined)).input_hash,
      payloadFor: (node) => ({ anchors: nodeAnchors(session.req_id, node.artifact) }),
      signal: controller.signal,
      // ADR-0023：节点声明 run 时由协调 agent 派发 worker；未配置 resolver 时执行器记 notes 跳过
      ...(driverResolver !== undefined && workspaceRoot !== undefined
        ? {
            nodeRunner: createNodeRunner(def, {
              resolveDriver: driverResolver,
              workspaceRoot,
              read_source_hash: async (node) => (await readVerificationSource(workspaceRoot, verificationSourceInputs(node))).source_hash,
            }),
          }
        : {}),
    });
    const promise = executor
      .run(def, session)
      .then(async () => {
        const events = await session.events.readOrdered();
        const status = this.computeFinalStatus(events, def, run.run_id, run.workflow_revision ?? undefined) ?? "completed";
        this.safeFinish(run.run_id, status, null);
        await session.rebuildLedger();
      })
      .catch((error: unknown) => {
        this.safeFinish(run.run_id, "failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        for (const [key, pending] of this.pendingAsks) if (pending.req_id === session.req_id) this.pendingAsks.delete(key);
        for (const key of this.decided.keys()) if (key.startsWith(`${session.req_id}:`)) this.decided.delete(key);
        this.active.delete(session.req_id);
      });
    this.active.set(session.req_id, { run_id: run.run_id, req_id: session.req_id, promise, controller,
      ...(driverResolver !== undefined ? { driverResolver } : {}),
    });
  }

  /**
   * HumanGate 桥：执行器先落 gate.waiting 事件再调 ask —— ask 时扫事件流找到
   * 当前未决 gate 作为定位键；有暂存决策立即消费，否则挂起 promise 等 REST 决策。
   */
  private createHumanGate(session: SessionHandle, run: RunRow, def: WorkflowDef): HumanGate {
    return {
      ask: async (question: string, options: string[], context): Promise<HumanGateAnswer> => {
        const events = await session.events.readOrdered();
        if (this.closing) return { kind: "recheck" };
        const pending = scanPendingApprovals(events);
        const current = context === undefined ? [...pending.values()].find((info) => info.question === question) :
          [...pending.values()].find((info) => info.waiting_event_id === context.waiting_event_id);
        if (current === undefined) {
          if (context !== undefined && events.some((event) => event.type === "gate.invalidated" && asRecord(event.payload)?.["waiting_event_id"] === context.waiting_event_id)) return { kind: "recheck" };
          throw new Error(`gate.waiting 事件缺失，无法定位审批（question=${question}）`);
        }
        const fullKey = `${session.req_id}:${current.waiting_event_id}`;
        for (const key of this.decided.keys()) {
          if (key.startsWith(`${session.req_id}:`) && key !== fullKey) this.decided.delete(key);
        }
        const predecided = this.decided.get(fullKey);
        if (predecided !== undefined) {
          this.decided.delete(fullKey);
          return predecided;
        }
        const recorded = [...events].reverse().find((event) => {
          const payload = asRecord(event.payload);
          return event.type === "human.decision.recorded" && payload?.["waiting_event_id"] === current.waiting_event_id && payload["evaluation_hash"] === context?.evaluation_hash;
        });
        const chosen = asRecord(recorded?.payload)?.["chosen"];
        if (typeof chosen === "string" && options.includes(chosen)) return chosen;
        const node = def.spec.nodes.find((item) => item.id === current.node_id);
        const gate = node?.gates.find((item) => item.id === current.gate_id);
        const verification_ids = gate === undefined ? [] : verificationIds(gate);
        let pending_ask!: PendingAsk;
        const answer = new Promise<HumanGateAnswer>((resolve) => {
          pending_ask = {
            req_id: session.req_id,
            run_id: run.run_id,
            node_id: current.node_id,
            gate_id: current.gate_id,
            waiting_event_id: current.waiting_event_id,
            verification_ids,
            question,
            options,
            resolve,
          };
          this.pendingAsks.set(fullKey, pending_ask);
        });
        if (node !== undefined && gate !== undefined && verification_ids.length > 0) {
          // 先登记挂起者再读事实：早到的结果由本次重检发现，晚到的结果由 recheck 唤醒。
          try {
            const evaluated = await this.evaluateRunGate(session, run, def, node, gate);
            if (evaluated.evaluation_hash !== current.evaluation_hash && this.pendingAsks.get(fullKey) === pending_ask) {
              this.pendingAsks.delete(fullKey);
              pending_ask.resolve({ kind: "recheck" });
            }
          } catch (error) {
            if (this.pendingAsks.get(fullKey) === pending_ask) this.pendingAsks.delete(fullKey);
            throw error;
          }
        }
        return answer;
      },
    };
  }

  private async evaluateRunGate(session: SessionHandle, run: RunRow, def: WorkflowDef, node: WorkflowDef["spec"]["nodes"][number], gate: GateDef) {
    const anchors = nodeAnchors(session.req_id, node.artifact);
    const configuration_hash = node.run === undefined ? null : this.configurationHashFor(session.req_id, node.run.agent);
    const { input_hash } = await this.readNodeInput(def, node, session, configuration_hash, run.workflow_revision ?? undefined);
    return evaluateGate(gate, createBuiltinRegistry(), {
      session_dir: session.dir, session, node_id: node.id, run_id: run.run_id,
      workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? undefined, anchors, payload: { anchors },
    }, input_hash);
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

function verificationIds(gate: GateDef): string[] {
  return gate.checks.flatMap((check) => check.ref === "verification-passed" && typeof check.with?.["verification_id"] === "string"
    ? [check.with["verification_id"]] : []);
}

/** 节点证据锚点：优先节点产物文档，否则需求 PRD（anchors-present 的事实来源） */
function nodeAnchors(reqId: string, artifact: string | undefined): Anchor[] {
  const doc = artifact ?? "prd.md";
  return [{ kind: "doc", anchor: `cord/${reqId}/${doc}` }];
}
