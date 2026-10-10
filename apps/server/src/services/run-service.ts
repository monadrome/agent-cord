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
  readGoalRetryAuthorization,
  readGoalRetryAgentIdentity,
  readGoalRecoveryRequest,
  goalRecoveryInputHash,
  goalRecoveryCheckpoint,
  GoalRetryAuthorizedPayloadSchema,
  GoalAttemptCompletedPayloadSchema,
  GoalRecoveryRequestedPayloadSchema,
  GoalAttemptStartedPayloadSchema,
  resolveGoalReadiness,
  accumulateGoalUsage,
  usageBudgetExceeded,
  readSessionDocument,
  readSessionEvents,
  type AgentDriver,
  type Anchor,
  type EventEnvelope,
  type GateDef,
  type HumanGate,
  type HumanGateAnswer,
  type SessionHandle,
  type WorkflowDef,
} from "agent-cord";
import type { GoalRecoveryView, RunInfo, RunStatus } from "../contracts.js";
import { conflict, notFound } from "../errors.js";
import { runRowToInfo, type IndexStore, type RunRow } from "./index-store.js";
import { decodeApprovalId, scanPendingApprovals, type SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";
import { readVerificationSource, verificationSourceInputs, VerificationInputError } from "./verification-inputs.js";
import { WorkspaceLease, WorkspaceLeaseBusy } from "./workspace-lease.js";
import { project_active_run_wait } from "./run-status.js";

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
  /** ADR-0058：Goal 阻塞后的受限自动协调入口。 */
  onGoalBlocked?: (context: GoalBlockedContext) => Promise<void>;
}

export interface GoalBlockedContext {
  req_id: string;
  run_id: string;
  sdlc_id: string;
  sdlc_version: number;
  workflow_id: string;
  workflow_revision: string | null;
  node_id: string;
  goal_event_id: string;
  supervisor_agent: string;
  supervisor_timeout_ms?: number;
  signal?: AbortSignal;
}

/** ADR-0033：运行槽位内校验人工采用依据，事实落盘成功后才启动执行器。 */
export interface RunStartGuard {
  coordination_round_id?: string;
  goal_retry_round_id?: string;
  driverResolver?: (name: string) => AgentDriver;
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
  private readonly goal_recovering = new Map<string, { input_hash: string; node_id?: string; promise: Promise<RunInfo> }>();
  /** ADR-0069/0070：同一 workspace 内的 agent run 不能并发写共享源码。 */
  private readonly workspace_lease: WorkspaceLease;
  /** 只保存已授权、可由启动事实重建的恢复引用，不创建新的排队 run。 */
  private readonly deferred_recoveries = new Set<string>();
  private workspace_recovery_timer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(sessions: SessionService, sdlcs: SdlcService, index: IndexStore, options: RunServiceOptions = {}) {
    this.sessions = sessions;
    this.sdlcs = sdlcs;
    this.index = index;
    this.options = options;
    this.workspace_lease = new WorkspaceLease(options.workspaceRoot);
  }

  setGoalBlockedHandler(handler: (context: GoalBlockedContext) => Promise<void>): void {
    this.options.onGoalBlocked = handler;
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
    if (this.workspace_recovery_timer !== undefined) clearTimeout(this.workspace_recovery_timer);
    this.workspace_recovery_timer = undefined;
    this.deferred_recoveries.clear();
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort();
    await Promise.all(active.map((run) => run.promise));
    await Promise.all([...this.goal_recovering.values()].map(operation => operation.promise.catch(() => undefined)));
    await this.recovery_queue.catch(() => undefined);
    this.workspace_lease.close();
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
    try { source = await readVerificationSource(this.options.workspaceRoot ?? "", inputs, node.run?.goal?.review_changes === true); }
    catch (error) {
      if (error instanceof VerificationInputError) throw error;
      throw new VerificationInputError("无法读取声明的验证输入，请检查工作区文件与访问权限");
    }
    const context_hash = await readApprovalContextHash(def, node, session, configuration_hash, workflow_revision);
    const { source_manifest, ...source_identity } = source;
    const input_hash = source.source_hash === null ? context_hash : sha256Hex(canonicalJson({
      domain: "cord.verification-input.v1", context_hash, ...source_identity,
    }));
    return { input_hash, ...source };
  }

  /** 当前绑定按启动事实的因果顺序确定；没有新协议事实时只读旧操作登记。 */
  async latestRun(req_id: string, events?: readonly EventEnvelope[]): Promise<RunRow | null> {
    const facts = events ?? await readSessionEvents(await this.sessions.open(req_id));
    for (const event of [...facts].reverse()) {
      if (event.type !== "workflow.run.started") continue;
      const parsed = WorkflowRunStartedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new Error("工作流启动绑定事件不符合契约");
      const payload = parsed.data;
      const row = this.index.getRun(payload.run_id);
      if (row === null || row.req_id !== req_id || row.sdlc_id !== payload.sdlc_id || row.sdlc_version !== payload.sdlc_version || row.workflow_revision !== payload.workflow_revision) throw new Error("运行登记与启动绑定事实不一致");
      return project_active_run_wait(row, facts, this.activeRunId(req_id));
    }
    return this.index.latestRun(req_id);
  }

  /** 启动（或恢复）某需求的 run；绑定具体 SDLC 版本（ADR-0022 决策 4） */
  async start(reqId: string, sdlcId?: string, sdlcVersion?: number, guard?: RunStartGuard): Promise<RunInfo> {
    if (this.closing) throw conflict("服务正在关闭，不能启动 run");
    if (guard?.coordination_round_id !== undefined && guard.goal_retry_round_id !== undefined) throw conflict("运行来源不能同时为人工采用与 Goal 续跑");
    if (this.active.has(reqId)) {
      throw conflict(`需求 ${reqId} 已有在途 run（${this.active.get(reqId)?.run_id}），等待其结束或人工处理`);
    }
    // 预留槽位必须发生在首个 await 之前，否则并发请求都可能通过检查。
    const reservedRunId = ulid();
    const controller = new AbortController();
    const driverResolver = guard?.driverResolver ?? this.options.driverResolverForRun?.() ?? this.options.driverResolver;
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
      this.reserveWorkspace(reqId, reservedRunId, versioned.def);
      await guard?.validate(session, versioned.def, versioned.workflow_revision);
      if (this.closing) throw conflict("服务正在关闭，不能登记新 run");
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
        goal_retry_round_id: guard?.goal_retry_round_id ?? null,
        workflow_revision: versioned.workflow_revision,
      };
      this.index.insertRun(run);
      registered = true;
      await session.events.append({ event_id: ulid(), session_id: reqId, type: "workflow.run.started", schema_version: "1",
        actor: { kind: "human", id: "local-human" }, correlation_id: reservedRunId,
        payload: { run_id: reservedRunId, workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, sdlc_id: versioned.sdlc_id, sdlc_version: versioned.version,
          ...(guard?.coordination_round_id === undefined ? {} : { coordination_round_id: guard.coordination_round_id }),
          ...(guard?.goal_retry_round_id === undefined ? {} : { goal_retry_round_id: guard.goal_retry_round_id }) }, source: { adapter: "console-server" } });
      await guard?.record(session, reservedRunId);
      await this.assertGoalRetryIdentity(session, await session.events.readOrdered(), run, versioned.def, driverResolver);
      if (this.closing) throw conflict("服务正在关闭，启动事实已保留，等待冷恢复");
      this.launch(session, run, versioned.def, controller, driverResolver);
      return runRowToInfo(run);
    } catch (error) {
      if (registered) this.safeFinish(reservedRunId, "failed", error instanceof Error ? error.message : String(error));
      this.releaseWorkspace(reqId, reservedRunId);
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
    const driverResolver = active?.driverResolver ?? this.options.driverResolverForRun?.() ?? this.options.driverResolver;
    await this.assertGoalRetryIdentity(session, events, latest, versioned.def, driverResolver);
    let current_hash: string;
    try {
      const evaluated = await this.evaluateRunGate(session, latest, versioned.def, node, gate, driverResolver);
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
      else if (!this.active.has(reqId)) {
        if (latest.goal_retry_round_id != null) await this.recover(latest.run_id);
        else await this.start(reqId, versioned.sdlc_id, versioned.version);
      }
      throw conflict("审批依据已变化，已重新检查；请确认当前审批");
    }

    const current_events = await session.events.readOrdered();
    if (gate.attach.when === "post") this.assertGoalAcceptanceProof(current_events, latest, versioned.def, node);
    const still_waiting = [...scanPendingApprovals(current_events).values()]
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
          status: "running", started_at: event.timestamp, finished_at: null, error: null, workflow_revision: payload.workflow_revision, coordination_round_id: payload.coordination_round_id ?? null,
          goal_retry_round_id: payload.goal_retry_round_id ?? null });
      }
    }
    const resumed: string[] = [];
    for (const run of this.index.listRuns()) {
      if (this.closing) break;
      if (run_id !== undefined && run.run_id !== run_id) continue;
      this.deferred_recoveries.delete(run.run_id);
      if (this.active.has(run.req_id)) continue;
      const session = await this.sessions.open(run.req_id);
      const events = await session.events.readOrdered();
      let pending_recovery = false;
      if (run.goal_retry_round_id != null) {
        try { const request = readGoalRecoveryRequest(events, run.run_id); pending_recovery = request !== null && !request.consumed; }
        catch (error) { this.index.finishRun(run.run_id, "failed", new Date().toISOString(), error instanceof Error ? error.message : "Goal 恢复请求不可验证"); continue; }
      }
      const explicit_retry_recovery = (run_id !== undefined || pending_recovery) && run.status === "failed" && run.goal_retry_round_id != null;
      if (run.status !== "running" && run.status !== "waiting_human" && !explicit_retry_recovery) continue;
      const started = events.filter((event) => event.type === "workflow.run.started").map((event) => WorkflowRunStartedPayloadSchema.safeParse(event.payload)).find((parsed) =>
        parsed.success && parsed.data.run_id === run.run_id && parsed.data.sdlc_id === run.sdlc_id && parsed.data.sdlc_version === run.sdlc_version
        && parsed.data.coordination_round_id === (run.coordination_round_id ?? undefined) && parsed.data.goal_retry_round_id === (run.goal_retry_round_id ?? undefined) && parsed.data.workflow_revision === run.workflow_revision);
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
      const driverResolver = this.options.driverResolverForRun?.() ?? this.options.driverResolver;
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
      if (run.goal_retry_round_id != null) {
        try {
          await this.assertGoalRetryIdentity(session, events, run, versioned.def, driverResolver);
          if (pending_recovery && is_current) await this.readGoalRecoveryState(run, driverResolver);
        } catch (error) {
          this.index.finishRun(run.run_id, "failed", new Date().toISOString(), error instanceof Error ? error.message : "Goal 续跑授权不可验证，拒绝恢复派发");
          continue;
        }
      }
      if (is_current) {
        try {
          for (const waiting of scanPendingApprovals(events, scope).values()) {
            const node = versioned.def.spec.nodes.find(item => item.id === waiting.node_id);
            if (node?.gates.some(gate => gate.id === waiting.gate_id && gate.attach.when === "post")) this.assertGoalAcceptanceProof(events, run, versioned.def, node);
          }
        } catch (error) {
          this.index.finishRun(run.run_id, "failed", new Date().toISOString(), error instanceof Error ? error.message : "Goal 验收来源不可验证");
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
          const evaluated = await this.evaluateRunGate(session, run, versioned.def, node, gate, driverResolver);
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
        const latest_goal = events.filter(event => ["goal.attempt.started", "goal.attempt.completed"].includes(event.type)
          && matchesWorkflowScope(event.payload, scope) && event.payload["run_id"] === run.run_id).at(-1);
        const goal = GoalAttemptCompletedPayloadSchema.safeParse(latest_goal?.payload);
        if (latest_goal?.type === "goal.attempt.completed" && goal.success && goal.data.status === "blocked") {
          this.index.finishRun(run.run_id, "failed", new Date().toISOString(), goal.data.reason);
          continue;
        }
        if (finalStatus !== null) this.index.finishRun(run.run_id, finalStatus, new Date().toISOString(), null);
        continue;
      }
      if (verification_unavailable) {
        this.index.setRunStatus(run.run_id, "waiting_human");
        continue;
      }
      if (run.status === "waiting_human" && !recorded_decision && !recorded_verification) continue;
      if (finalStatus !== null && !(finalStatus === "waiting_human" && (recorded_decision || recorded_verification)) && !(pending_recovery && finalStatus === "failed")) {
        this.index.finishRun(run.run_id, finalStatus, new Date().toISOString(), null);
        continue;
      }
      const latest = await this.latestRun(run.req_id);
      if (latest?.run_id !== run.run_id || (latest.status !== "running" && latest.status !== "waiting_human" && !explicit_retry_recovery) || this.active.has(run.req_id)) continue;
      try { this.reserveWorkspace(run.req_id, run.run_id, versioned.def); }
      catch (error) {
        if (error instanceof WorkspaceLeaseBusy) {
          this.deferred_recoveries.add(run.run_id);
          this.scheduleWorkspaceRecovery();
        } else this.index.finishRun(run.run_id, "failed", new Date().toISOString(), error instanceof Error ? error.message : "工作区执行锁不可验证");
        continue;
      }
      try {
        this.index.setRunStatus(run.run_id, "running");
        this.launch(session, run, versioned.def, new AbortController(), driverResolver);
      } catch (error) { this.releaseWorkspace(run.req_id, run.run_id); throw error; }
      resumed.push(`${run.req_id}(${run.run_id})`);
    }
    return resumed;
  }

  private assertGoalAcceptanceProof(events: readonly EventEnvelope[], run: RunRow, def: WorkflowDef, node: WorkflowDef["spec"]["nodes"][number]): void {
    if (node.run?.goal === undefined || (node.run.goal.acceptance === undefined && node.run.goal.usage_budget === undefined && node.run.goal.review_changes !== true)) return;
    const scope = { workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? undefined, run_id: run.run_id };
    const ready = events.filter(event => event.type === "goal.attempt.completed" && matchesWorkflowScope(event.payload, scope)
      && event.payload["run_id"] === run.run_id && event.payload["node_id"] === node.id).at(-1);
    if (ready === undefined || resolveGoalReadiness(ready, events, node, scope) === null) throw conflict("Goal 声明验收覆盖来源不可验证，拒绝恢复或人工放行");
  }

  /** 授权身份在恢复与人审共用；首次派发还须保持人工确认的节点输入。 */
  private async assertGoalRetryIdentity(session: SessionHandle, events: readonly EventEnvelope[], run: RunRow, def: WorkflowDef, resolver?: (name: string) => AgentDriver, validate_recovery = true): Promise<void> {
    if (run.goal_retry_round_id == null) return;
    let event;
    try { event = readGoalRetryAuthorization(events, run.run_id); }
    catch (error) { throw conflict(error instanceof Error ? error.message : "Goal 续跑授权来源不可验证"); }
    const auth = GoalRetryAuthorizedPayloadSchema.safeParse(event?.payload);
    const node = auth.success ? def.spec.nodes.find(node => node.id === auth.data.node_id) : undefined;
    const goal = node?.run?.goal;
    if (!auth.success || auth.data.round_id !== run.goal_retry_round_id || !matchesWorkflowScope(auth.data, { workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? undefined })
      || node === undefined || goal === undefined || goal.max_attempts !== auth.data.max_attempts || goal.timeout_ms !== auth.data.timeout_ms) throw conflict("Goal 续跑授权缺失或来源/预算不可验证，拒绝派发");
    let identity;
    try { identity = readGoalRetryAgentIdentity(events, run.run_id, node); }
    catch (error) { throw conflict(error instanceof Error ? error.message : "Goal 续跑 worker 配置来源不可验证"); }
    if (resolver?.(node.run!.agent).configuration_hash !== identity.configuration_hash) throw conflict("Goal 续跑 worker 配置与人工授权不一致，请恢复原配置后恢复原 run");
    if (!identity.worker_started) {
      const current = await this.readNodeInput(def, node, session, identity.configuration_hash, run.workflow_revision ?? undefined);
      if (current.input_hash !== identity.node_input_hash) throw conflict("Goal 续跑首次派发前输入已变化，拒绝执行旧授权");
    }
    const recovery = readGoalRecoveryRequest(events, run.run_id);
    if (validate_recovery && recovery !== null && !recovery.consumed) {
      const current = await this.readNodeInput(def, node, session, identity.configuration_hash, run.workflow_revision ?? undefined);
      if (recovery.request.agent_configuration_hash !== identity.configuration_hash || recovery.request.node_input_hash !== current.input_hash) throw conflict("Goal 恢复请求尚未执行，输入已变化，请刷新后重新恢复");
    }
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
      } else if (event.type === "goal.attempt.completed" && payload["run_id"] === runId && typeof nodeId === "string") {
        if (payload["status"] === "ready") failedNodes.delete(nodeId);
        else if (payload["status"] !== "cancelled") failedNodes.add(nodeId);
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
  private launch(session: SessionHandle, run: RunRow, def: WorkflowDef, controller: AbortController, fixed_resolver?: (name: string) => AgentDriver): void {
    if (this.closing) { this.releaseWorkspace(session.req_id, run.run_id); return; }
    const humanGate = this.createHumanGate(session, run, def);
    const { workspaceRoot } = this.options;
    const driverResolver = fixed_resolver ?? this.options.driverResolverForRun?.() ?? this.options.driverResolver;
    const nodeRunner = driverResolver !== undefined && workspaceRoot !== undefined ? createNodeRunner(def, {
      resolveDriver: driverResolver,
      workspaceRoot,
      read_source_hash: async (node) => (await readVerificationSource(workspaceRoot, verificationSourceInputs(node))).source_hash,
      read_verification_input: async (node, current_session, ctx) => this.readNodeInput(def, node, current_session,
        driverResolver(node.run!.agent).configuration_hash ?? null, ctx.workflow_revision),
    }) : undefined;
    const executor = createExecutor({
      run_id: run.run_id,
      workflow_revision: run.workflow_revision ?? undefined,
      humanGate,
      gateInputHash: async (node) => (await this.readNodeInput(def, node, session,
        node.run !== undefined ? driverResolver?.(node.run.agent).configuration_hash ?? null : null, run.workflow_revision ?? undefined)).input_hash,
      payloadFor: (node) => ({ anchors: nodeAnchors(session.req_id, node.artifact) }),
      signal: controller.signal,
      // ADR-0023：节点声明 run 时由协调 agent 派发 worker；未配置 resolver 时执行器记 notes 跳过
      ...(nodeRunner !== undefined
        ? {
            nodeRunner: { ...nodeRunner, runNode: async (node, current_session, ctx) => {
              await this.assertGoalRetryIdentity(current_session, await current_session.events.readOrdered(), run, def, driverResolver);
              return nodeRunner.runNode(node, current_session, ctx);
            } },
          }
        : {}),
    });
    const promise = executor
      .run(def, session)
      .then(async () => {
        const events = await session.events.readOrdered();
        const status = this.computeFinalStatus(events, def, run.run_id, run.workflow_revision ?? undefined) ?? "completed";
        const blocked_goal = [...events].reverse().find(event => event.type === "goal.attempt.completed" && matchesWorkflowScope(event.payload, { workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? undefined })
          && event.payload["run_id"] === run.run_id && event.payload["status"] === "blocked");
        this.safeFinish(run.run_id, status, status === "failed" && blocked_goal !== undefined ? String(asRecord(blocked_goal.payload)?.["reason"]) : null);
        await session.rebuildLedger();
        if (!this.closing && status === "failed" && blocked_goal !== undefined && this.options.onGoalBlocked !== undefined) {
          const blocked_payload = asRecord(blocked_goal.payload);
          const node_id = typeof blocked_payload?.["node_id"] === "string" ? blocked_payload["node_id"] : null;
          const node = node_id === null ? undefined : def.spec.nodes.find(item => item.id === node_id);
          const supervisor_agent = node?.run?.goal?.supervisor_agent;
          if (node_id !== null && node !== undefined && supervisor_agent !== undefined) {
            try {
              await this.options.onGoalBlocked({
                req_id: session.req_id, run_id: run.run_id, sdlc_id: run.sdlc_id, sdlc_version: run.sdlc_version,
                workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? null, node_id, goal_event_id: blocked_goal.event_id,
                supervisor_agent,
                signal: controller.signal,
                ...(node.run?.goal?.supervisor_timeout_ms === undefined ? {} : { supervisor_timeout_ms: node.run.goal.supervisor_timeout_ms }),
              });
            } catch { /* 自动升级失败不覆盖原 run failed 事实；协调视图保留失败或未启动状态。 */ }
          }
        }
      })
      .catch((error: unknown) => {
        this.safeFinish(run.run_id, "failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        for (const [key, pending] of this.pendingAsks) if (pending.req_id === session.req_id) this.pendingAsks.delete(key);
        for (const key of this.decided.keys()) if (key.startsWith(`${session.req_id}:`)) this.decided.delete(key);
        this.active.delete(session.req_id);
        this.releaseWorkspace(session.req_id, run.run_id);
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
            // 源码暂不可读时保留未决等待，修复后的验证提交仍可唤醒。
            if (error instanceof VerificationInputError) return answer;
            if (this.pendingAsks.get(fullKey) === pending_ask) this.pendingAsks.delete(fullKey);
            throw error;
          }
        }
        return answer;
      },
    };
  }

  private async evaluateRunGate(session: SessionHandle, run: RunRow, def: WorkflowDef, node: WorkflowDef["spec"]["nodes"][number], gate: GateDef, resolver?: (name: string) => AgentDriver) {
    const anchors = nodeAnchors(session.req_id, node.artifact);
    const configuration_hash = node.run === undefined ? null : resolver === undefined ? this.configurationHashFor(session.req_id, node.run.agent) : resolver(node.run.agent).configuration_hash ?? null;
    const { input_hash } = await this.readNodeInput(def, node, session, configuration_hash, run.workflow_revision ?? undefined);
    return evaluateGate(gate, createBuiltinRegistry(), {
      session_dir: session.dir, session, node_id: node.id, run_id: run.run_id,
      workflow_id: def.metadata.id, workflow_revision: run.workflow_revision ?? undefined, anchors, payload: { anchors },
    }, input_hash);
  }

  async getRun(runId: string): Promise<RunInfo> {
    const row = this.index.getRun(runId);
    if (row === null) throw notFound(`run 不存在：${runId}`);
    return runRowToInfo(await this.readRunProjection(row));
  }

  private async readRunProjection(row: RunRow, events?: readonly EventEnvelope[]): Promise<RunRow> {
    if (this.activeRunId(row.req_id) !== row.run_id || !["running", "waiting_human"].includes(row.status)) return row;
    const facts = events ?? await readSessionEvents(await this.sessions.open(row.req_id));
    const current = this.index.getRun(row.run_id) ?? row;
    return project_active_run_wait(current, facts, this.activeRunId(row.req_id));
  }

  /** REST 查询使用事实投影；同需求的多条登记共用一次读取，不重复扫文件。 */
  async readRuns(req_id?: string): Promise<RunInfo[]> {
    const rows = this.index.listRuns(req_id);
    const facts = new Map<string, Promise<EventEnvelope[]>>();
    for (const row of rows) if (this.activeRunId(row.req_id) === row.run_id && ["running", "waiting_human"].includes(row.status)) {
      if (!facts.has(row.req_id)) facts.set(row.req_id, this.sessions.open(row.req_id).then(readSessionEvents));
    }
    return Promise.all(rows.map(async row => runRowToInfo(await this.readRunProjection(row, await facts.get(row.req_id)))));
  }

  /** 读取原授权 Goal 的恢复依据；不创建新 run，也不改变事件事实。 */
  async goalRecovery(runId: string): Promise<GoalRecoveryView> {
    const run = this.index.getRun(runId);
    if (run === null) throw notFound(`run 不存在：${runId}`);
    const view: GoalRecoveryView = { run_id: runId, available: false, reason: null, input_hash: null, node_id: null,
      authorization_event_id: null, remaining_attempts: null, deadline_at: null, ready_current: false };
    try {
      const resolver = this.options.driverResolverForRun?.() ?? this.options.driverResolver;
      const state = await this.readGoalRecoveryState(run, resolver);
      Object.assign(view, state.view);
    } catch (error) { view.reason = error instanceof Error ? error.message : "无法核验 Goal 恢复依据"; }
    return view;
  }

  private async readGoalRecoveryState(run: RunRow, resolver?: (name: string) => AgentDriver, reservation?: AbortController) {
    if (this.closing) throw conflict("服务正在关闭");
    if (run.goal_retry_round_id == null) throw conflict("当前 run 不是人工授权的 Goal 续跑");
    if (run.status === "completed" || run.status === "cancelled") throw conflict("run 已结束，不能恢复");
    const active = this.active.get(run.req_id);
    if (active !== undefined && active.controller !== reservation) throw conflict("需求仍有执行体，请等待当前 run 收束");
    const session = await this.sessions.open(run.req_id); const events = await session.events.readOrdered();
    if ((await this.latestRun(run.req_id, events))?.run_id !== run.run_id) throw conflict("只能恢复当前 run，旧 run 已被替代");
    const versioned = await this.sdlcs.get(run.sdlc_id, run.sdlc_version);
    if (run.workflow_revision !== versioned.workflow_revision) throw conflict("绑定 SDLC 执行版本已变化");
    const scope = { workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, run_id: run.run_id };
    if (events.some(event => event.type === "workflow.run.cancelled" && matchesWorkflowScope(event.payload, scope) && event.payload["run_id"] === run.run_id)) throw conflict("run 已取消，不能恢复");
    await this.assertGoalRetryIdentity(session, events, run, versioned.def, resolver, false);
    const auth_event = readGoalRetryAuthorization(events, run.run_id)!;
    const auth = GoalRetryAuthorizedPayloadSchema.parse(auth_event.payload);
    const node = versioned.def.spec.nodes.find(item => item.id === auth.node_id)!;
    const goal = node.run!.goal!;
    if (events.some(event => event.type === "workflow.node.exited" && matchesWorkflowScope(event.payload, scope) && event.payload["node_id"] === node.id)) throw conflict("原 Goal 节点已退出，不能重复恢复");
    const identity = readGoalRetryAgentIdentity(events, run.run_id, node);
    const assert_current_configuration = () => {
      if (reservation === undefined) return;
      const current = this.options.driverResolverForRun?.() ?? this.options.driverResolver;
      if (current?.(node.run!.agent).configuration_hash !== identity.configuration_hash) throw conflict("恢复授权记录前 worker 配置已变化，请刷新");
    };
    assert_current_configuration();
    const input = await this.readNodeInput(versioned.def, node, session, identity.configuration_hash, versioned.workflow_revision);
    const checkpoint = goalRecoveryCheckpoint(events, { ...scope, node_id: node.id });
    let ready_current = false;
    if (checkpoint?.type === "goal.attempt.completed" && asRecord(checkpoint.payload)?.["status"] === "ready") {
      const evidence = resolveGoalReadiness(checkpoint, events, node, scope);
      const guide = await readSessionDocument(session.dir, node.artifact!);
      ready_current = evidence !== null && guide !== null && evidence.input_hash === input.input_hash
        && evidence.source_hash === input.source_hash && evidence.artifact_hash === sha256Hex(guide);
    }
    const starts = events.filter(event => event.type === "goal.attempt.started" && matchesWorkflowScope(event.payload, scope)
      && event.payload["run_id"] === run.run_id && event.payload["node_id"] === node.id);
    const attempt = Math.max(0, ...starts.map(event => GoalAttemptStartedPayloadSchema.parse(event.payload).attempt));
    const remaining_attempts = Math.max(0, goal.max_attempts - attempt);
    const deadline_ms = starts[0] === undefined ? null : Date.parse(starts[0].timestamp) + goal.timeout_ms;
    if (deadline_ms !== null && !Number.isFinite(deadline_ms)) throw conflict("Goal 原截止时间不可验证");
    if (!ready_current) {
      if (goal.usage_budget !== undefined) {
        const usage = accumulateGoalUsage(events, run.run_id, node.id, { ...scope, session_id: session.req_id, driver: node.run!.agent });
        if (usageBudgetExceeded(goal.usage_budget, usage) !== null) throw conflict("Goal 原 usage 预算超限或计量未知，恢复不能重置");
      }
      if (checkpoint?.type === "goal.attempt.completed" && asRecord(checkpoint.payload)?.["status"] === "blocked") throw conflict("Goal 已阻塞，需要人工处理卡点后独立授权新预算");
      if (remaining_attempts === 0 || (deadline_ms !== null && deadline_ms <= Date.now())) throw conflict("Goal 原尝试或时长预算已耗尽，恢复不能重置");
    }
    const prior = readGoalRecoveryRequest(events, run.run_id);
    const current_input = await this.readNodeInput(versioned.def, node, session, identity.configuration_hash, versioned.workflow_revision);
    if (current_input.input_hash !== input.input_hash) throw conflict("读取恢复依据期间输入已变化，请刷新");
    assert_current_configuration();
    const request_input = { ...scope, node_id: node.id, authorization_event_id: auth_event.event_id,
      checkpoint_event_id: checkpoint?.event_id ?? null, prior_request_event_id: prior?.event.event_id ?? null,
      node_input_hash: input.input_hash, agent_configuration_hash: identity.configuration_hash };
    const view: GoalRecoveryView = { run_id: run.run_id, available: run.status === "failed" || run.status === "blocked", reason: run.status === "waiting_human" ? "原 run 已在等待人工处理" : run.status === "running" ? "原 run 正在等待自动恢复" : null,
      input_hash: goalRecoveryInputHash(request_input), node_id: node.id, authorization_event_id: auth_event.event_id,
      remaining_attempts, deadline_at: deadline_ms === null ? null : new Date(deadline_ms).toISOString(), ready_current };
    return { session, events, versioned, request_input, view };
  }

  /** 持久化恢复意图后继续原 run；恢复失败只保留请求事实，不授予新预算。 */
  recoverGoal(runId: string, input_hash: string, node_id?: string): Promise<RunInfo> {
    const pending = this.goal_recovering.get(runId);
    if (pending !== undefined) return pending.input_hash === input_hash && pending.node_id === node_id ? pending.promise : Promise.reject(conflict("已有不同依据或节点的 Goal 恢复正在处理"));
    const operation = this.recoverGoalOnce(runId, input_hash, node_id).finally(() => { if (this.goal_recovering.get(runId)?.promise === operation) this.goal_recovering.delete(runId); });
    this.goal_recovering.set(runId, { input_hash, ...(node_id === undefined ? {} : { node_id }), promise: operation });
    return operation;
  }

  private async recoverGoalOnce(runId: string, input_hash: string, node_id?: string): Promise<RunInfo> {
    if (this.closing) throw conflict("服务正在关闭");
    const run = this.index.getRun(runId);
    if (run === null) throw notFound(`run 不存在：${runId}`);
    const existing = this.active.get(run.req_id);
    const controller = new AbortController();
    const resolver = this.options.driverResolverForRun?.() ?? this.options.driverResolver;
    if (existing === undefined) this.active.set(run.req_id, { run_id: runId, req_id: run.req_id, promise: Promise.resolve(), controller, driverResolver: resolver });
    let launched = false;
    try {
      const session = await this.sessions.open(run.req_id); const events = await session.events.readOrdered();
      const prior = readGoalRecoveryRequest(events, runId);
      if (prior?.request.input_hash === input_hash) {
        if (node_id !== undefined && prior.request.node_id !== node_id) throw conflict("恢复节点不匹配原请求");
        return this.getRun(runId);
      }
      if (existing !== undefined) throw conflict("需求仍有执行体，不能恢复");
      const state = await this.readGoalRecoveryState(run, resolver, controller);
      if (node_id !== undefined && state.view.node_id !== node_id) throw conflict("只能恢复原授权的未退出 Goal 节点");
      if (!state.view.available || state.view.input_hash !== input_hash) throw conflict(state.view.reason ?? "Goal 恢复依据已变化，请刷新");
      const checked = await this.readGoalRecoveryState(run, resolver, controller);
      if (checked.view.input_hash !== input_hash) throw conflict("Goal 恢复依据在核验期间已变化");
      this.reserveWorkspace(run.req_id, run.run_id, state.versioned.def);
      const payload = GoalRecoveryRequestedPayloadSchema.parse({ ...checked.request_input, input_hash });
      await session.events.append({ event_id: ulid(), session_id: run.req_id, type: "goal.recovery.requested", schema_version: "1",
        actor: { kind: "human", id: "local-human" }, correlation_id: runId, payload, source: { adapter: "console-server" } });
      if (this.closing) throw conflict("服务正在关闭，恢复请求已保留，等待冷恢复");
      await this.assertGoalRetryIdentity(session, await session.events.readOrdered(), run, state.versioned.def, resolver);
      if (state.view.ready_current && this.computeFinalStatus(await session.events.readOrdered(), state.versioned.def, runId, run.workflow_revision!) === "waiting_human") {
        this.index.setRunStatus(runId, "waiting_human");
      } else {
        this.index.setRunStatus(runId, "running");
        this.launch(session, run, state.versioned.def, controller, resolver);
        launched = true;
      }
      return this.getRun(runId);
    } finally {
      if (!launched && this.active.get(run.req_id)?.controller === controller) {
        this.active.delete(run.req_id);
        this.releaseWorkspace(run.req_id, run.run_id);
      }
    }
  }

  /** 同步操作登记供恢复/维护；公开查询使用 readRuns。 */
  listRuns(reqId?: string): RunInfo[] {
    return this.index.listRuns(reqId).map(runRowToInfo);
  }

  private reserveWorkspace(req_id: string, run_id: string, def: WorkflowDef): void {
    if (this.closing) throw conflict("服务正在关闭，不能占用工作区");
    if (this.options.workspaceRoot === undefined || !def.spec.nodes.some(node => node.run !== undefined)) return;
    this.workspace_lease.acquire(req_id, run_id);
  }

  private releaseWorkspace(req_id: string, run_id: string): void {
    if (!this.workspace_lease.release(req_id, run_id)) return;
    if (!this.closing) for (const deferred of this.deferred_recoveries) void this.recover(deferred).catch(() => undefined);
  }

  private scheduleWorkspaceRecovery(): void {
    if (this.closing || this.workspace_recovery_timer !== undefined || this.deferred_recoveries.size === 0) return;
    this.workspace_recovery_timer = setTimeout(() => {
      this.workspace_recovery_timer = undefined;
      if (!this.closing) for (const run_id of this.deferred_recoveries) void this.recover(run_id).catch(() => undefined);
    }, 1_000);
    this.workspace_recovery_timer.unref();
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
