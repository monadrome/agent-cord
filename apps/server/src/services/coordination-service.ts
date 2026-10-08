/** 独立协调轮次的后台生命周期；所有持久化状态均从事件流投影（ADR-0032）。 */
import { ulid } from "ulid";
import {
  CoordinatorRoundRequestedPayloadSchema, CoordinatorRoundStartedPayloadSchema,
  CoordinatorRoundCompletedPayloadSchema, createContextSessionAgent,
  CoordinatorRoundAdoptedPayloadSchema, coordinationInputHash, parseCoordinationProposal, readSnapshot,
  type AgentDriver, type EventEnvelope, type SessionHandle, type WorkflowDef,
} from "agent-cord";
import type { CoordinationRoundView, RunInfo, StartCoordinationInput } from "../contracts.js";
import { conflict, internalError, notFound } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";
import type { RunService } from "./run-service.js";
import { readVerificationSource, verificationSourceInputs } from "./verification-inputs.js";
import { readCoordinationVerifications } from "./verification-context.js";

interface ActiveCoordination {
  round_id: string;
  controller: AbortController;
  promise: Promise<void>;
}

function projectRounds(events: readonly EventEnvelope[], req_id: string): CoordinationRoundView[] {
  const rounds = new Map<string, CoordinationRoundView>();
  for (const event of events) {
    if (event.type === "coordinator.round.requested") {
      const parsed = CoordinatorRoundRequestedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw internalError("协调请求事件不符合契约");
      const payload = parsed.data;
      rounds.set(payload.round_id, {
        round_id: payload.round_id, req_id, sdlc_id: payload.sdlc_id, sdlc_version: payload.sdlc_version,
        workflow_id: payload.workflow_id, driver: payload.driver, agent: payload.driver, status: "pending",
        workflow_revision: payload.workflow_revision ?? null,
        requested_at: event.timestamp, started_at: null, finished_at: null,
        snapshot_id: null, input_hash: null, agent_configuration_hash: null, source_hash: null, verification_context_hash: null,
        proposal: null, error: null, failure_stage: null,
        current: null, adoptable: false, adoption_reason: null, adopted_run_id: null, adopted_at: null,
      });
    } else if (event.type === "coordinator.round.started" || event.type === "coordinator.round.completed") {
      const parsed = event.type === "coordinator.round.started" ? CoordinatorRoundStartedPayloadSchema.safeParse(event.payload) : CoordinatorRoundCompletedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw internalError("协调轮次事件不符合契约");
      const payload = parsed.data;
      const round = rounds.get(payload.round_id);
      if (round === undefined) continue; // 库调用轮次没有 server request 登记，不冒充 API 任务。
      if ((payload.workflow_revision ?? null) !== round.workflow_revision) throw internalError("协调轮次的执行版本不一致");
      Object.assign(round, { driver: payload.driver, snapshot_id: payload.snapshot_id ?? round.snapshot_id,
        input_hash: payload.input_hash ?? round.input_hash, agent_configuration_hash: payload.agent_configuration_hash ?? round.agent_configuration_hash,
        source_hash: payload.source_hash ?? round.source_hash, verification_context_hash: payload.verification_context_hash ?? round.verification_context_hash });
      if (event.type === "coordinator.round.started") {
        round.status = "running";
        round.started_at = event.timestamp;
      } else {
        const completion = CoordinatorRoundCompletedPayloadSchema.parse(event.payload);
        Object.assign(round, { status: completion.status, proposal: completion.proposal, error: completion.error,
          failure_stage: completion.failure_stage ?? null, finished_at: event.timestamp });
      }
    } else if (event.type === "coordinator.round.adopted") {
      const parsed = CoordinatorRoundAdoptedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw internalError("协调采用事件不符合契约");
      const round = rounds.get(parsed.data.round_id);
      if (round === undefined || round.status !== "ok" || round.proposal?.next_action.kind !== "advance" ||
        round.workflow_id !== parsed.data.workflow_id || round.proposal.next_action.node_id !== parsed.data.node_id || round.input_hash !== parsed.data.input_hash ||
        round.workflow_revision !== (parsed.data.workflow_revision ?? null) ||
        (round.adopted_run_id !== null && round.adopted_run_id !== parsed.data.run_id)) throw internalError("协调采用事实与提议版本不一致");
      Object.assign(round, { adopted_run_id: parsed.data.run_id, adopted_at: event.timestamp });
    }
  }
  return [...rounds.values()].reverse();
}

export class CoordinationService {
  private readonly active = new Map<string, ActiveCoordination>();
  private readonly cancellation = new Map<string, Promise<CoordinationRoundView>>();
  private readonly storage_errors = new Map<string, string>();
  private readonly adoption = new Map<string, Promise<RunInfo>>();
  private closing = false;

  constructor(private readonly sessions: SessionService, private readonly sdlcs: SdlcService,
    private readonly options: { workspaceRoot: string; resolver: () => (name: string) => AgentDriver; runs: RunService; onError?: (error: unknown) => void }) {}

  start(req_id: string, input: StartCoordinationInput): Promise<CoordinationRoundView> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    if (this.active.has(req_id)) return Promise.reject(conflict(`需求 ${req_id} 已有在途协调轮次`));
    const active: ActiveCoordination = { round_id: ulid(), controller: new AbortController(), promise: Promise.resolve() };
    this.active.set(req_id, active);
    let resolve_ready!: (view: CoordinationRoundView) => void;
    let reject_ready!: (error: unknown) => void;
    const ready = new Promise<CoordinationRoundView>((resolve, reject) => { resolve_ready = resolve; reject_ready = reject; });
    let requested = false;
    active.promise = (async () => {
      const resolver = this.options.resolver();
      const session = await this.sessions.open(req_id);
      const versioned = await this.sdlcs.get(input.sdlc_id ?? DEFAULT_SDLC_ID, input.sdlc_version);
      if (this.sdlcs.isArchived(versioned.sdlc_id, versioned.version)) throw conflict("归档 SDLC 版本不能启动新协调轮次");
      await session.events.append({
        event_id: ulid(), session_id: req_id, type: "coordinator.round.requested", schema_version: "1",
        actor: { kind: "human", id: "local-human" }, correlation_id: active.round_id,
        payload: { round_id: active.round_id, workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, driver: input.agent, sdlc_id: versioned.sdlc_id, sdlc_version: versioned.version },
        source: { adapter: "console-server" },
      });
      requested = true;
      resolve_ready(await this.get(req_id, active.round_id));
      await createContextSessionAgent({ resolveDriver: resolver, workspaceRoot: this.options.workspaceRoot,
        read_source_hash: (def) => this.read_source_hash(def),
        read_verifications: (def, session, revision) => readCoordinationVerifications(def, session, revision, this.options.runs),
      }).coordinate(versioned.def, session, {
        round_id: active.round_id, agent: input.agent, signal: active.controller.signal,
        workflow_revision: versioned.workflow_revision,
        ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
      });
    })().catch((error: unknown) => {
      if (!requested) reject_ready(error);
      else {
        this.storage_errors.set(active.round_id, error instanceof Error ? error.message : "协调事实写入失败");
        reject_ready(error);
        this.options.onError?.(error);
      }
    }).finally(() => { if (this.active.get(req_id) === active) this.active.delete(req_id); });
    return ready;
  }

  async list(req_id: string): Promise<CoordinationRoundView[]> {
    const rounds = await this.readRounds(req_id);
    return Promise.all(rounds.map(async (round) => ({ ...round, ...await this.inspect(round) })));
  }

  async get(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    if (this.storage_errors.has(round_id)) throw internalError("协调轮次事实写入失败，需要修复存储后恢复", this.storage_errors.get(round_id));
    const round = await this.readRound(req_id, round_id);
    return { ...round, ...await this.inspect(round) };
  }

  private async readRound(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    const round = (await this.readRounds(req_id)).find((item) => item.round_id === round_id);
    if (round === undefined) throw notFound(`协调轮次不存在：${round_id}`);
    return round;
  }

  private async readRounds(req_id: string): Promise<CoordinationRoundView[]> {
    const rounds = projectRounds(await this.sessions.readEvents(req_id), req_id);
    const active = this.active.get(req_id);
    const current = rounds.find((round) => round.round_id === active?.round_id);
    if (active !== undefined && current !== undefined && current.status !== "pending" && current.status !== "running") await active.promise;
    return rounds;
  }

  private async inspect(round: CoordinationRoundView, def?: WorkflowDef, workflow_revision?: string): Promise<Pick<CoordinationRoundView, "current" | "adoptable" | "adoption_reason">> {
    const result = { current: null as boolean | null, adoptable: false, adoption_reason: null as string | null };
    if (round.status !== "ok" || round.proposal === null) return result;
    try {
      const versioned = def === undefined ? await this.sdlcs.get(round.sdlc_id, round.sdlc_version) : { def, workflow_revision };
      const workflow = versioned.def;
      if (round.workflow_revision === null) { result.adoption_reason = "该轮次缺少执行版本，请重新协调"; return result; }
      if (round.workflow_revision !== versioned.workflow_revision) { result.current = false; result.adoption_reason = "绑定的工作流定义已变化，请发布新版本并重新协调"; return result; }
      if (workflow.metadata.id !== round.workflow_id) throw new Error("workflow 不匹配");
      const configuration_hash = this.options.resolver()(round.agent).configuration_hash;
      if (round.agent_configuration_hash === null || configuration_hash === undefined) {
        result.adoption_reason = "无法验证 Agent 配置身份，请重新协调";
        return result;
      }
      const session = await this.sessions.open(round.req_id);
      const snapshot = await readSnapshot(session, { workflow_id: workflow.metadata.id, workflow_revision: round.workflow_revision, files: workflow.spec.nodes.flatMap((node) => node.artifact === undefined ? [] : [node.artifact]) });
      const source_hash = await this.read_source_hash(workflow);
      const verifications = await readCoordinationVerifications(workflow, session, round.workflow_revision, this.options.runs);
      result.current = round.source_hash === source_hash && coordinationInputHash(workflow, snapshot, configuration_hash, undefined, source_hash, verifications) === round.input_hash;
      if (!result.current) result.adoption_reason = "需求、源码、验证、进度或 Agent 配置已变化，请重新协调";
      else if (this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) result.adoption_reason = "绑定的 SDLC 版本已归档";
      else if (round.adopted_run_id !== null) result.adoption_reason = "提议已采用";
      else if (round.proposal.next_action.kind !== "advance") result.adoption_reason = "当前提议不启动 SDLC";
      else {
        parseCoordinationProposal(JSON.stringify(round.proposal), workflow, snapshot, verifications);
        result.adoptable = true;
      }
    } catch { result.adoption_reason = "无法验证当前协调依据，请刷新或重新协调"; }
    return result;
  }

  private async read_source_hash(def: WorkflowDef): Promise<string | null> {
    const inputs = [...new Set(def.spec.nodes.flatMap(verificationSourceInputs))].sort();
    return (await readVerificationSource(this.options.workspaceRoot, inputs)).source_hash;
  }

  adopt(req_id: string, round_id: string): Promise<RunInfo> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    const key = JSON.stringify([req_id, round_id]);
    const pending = this.adoption.get(key);
    if (pending !== undefined) return pending;
    const operation = this.adoptOnce(req_id, round_id).finally(() => this.adoption.delete(key));
    this.adoption.set(key, operation);
    return operation;
  }

  private async adoptOnce(req_id: string, round_id: string): Promise<RunInfo> {
    const round = await this.get(req_id, round_id);
    if (round.adopted_run_id !== null) return this.options.runs.getRun(round.adopted_run_id);
    if (!round.adoptable || round.proposal?.next_action.kind !== "advance" || round.input_hash === null) throw conflict(round.adoption_reason ?? "协调提议不可采用");
    const node_id = round.proposal.next_action.node_id;
    return this.options.runs.start(req_id, round.sdlc_id, round.sdlc_version, {
      coordination_round_id: round_id,
      validate: async (_session, def, workflow_revision) => {
        const current = await this.readRound(req_id, round_id);
        const inspected = await this.inspect(current, def, workflow_revision);
        if (!inspected.adoptable || current.input_hash !== round.input_hash) throw conflict(inspected.adoption_reason ?? "协调提议已变化，请重新协调");
      },
      record: async (session, run_id) => {
        await session.events.append({ event_id: ulid(), session_id: req_id, type: "coordinator.round.adopted", schema_version: "1",
          actor: { kind: "human", id: "local-human" }, correlation_id: round_id,
          payload: { round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision, node_id, input_hash: round.input_hash, run_id }, source: { adapter: "console-server" } });
      },
    });
  }

  cancel(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    const key = JSON.stringify([req_id, round_id]);
    const pending = this.cancellation.get(key);
    if (pending !== undefined) return pending;
    const operation = this.cancelOnce(req_id, round_id).finally(() => this.cancellation.delete(key));
    this.cancellation.set(key, operation);
    return operation;
  }

  private async cancelOnce(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    const round = await this.get(req_id, round_id);
    if (round.status !== "pending" && round.status !== "running") return round;
    const session = await this.sessions.open(req_id);
    const events = await session.events.readOrdered();
    if (!events.some((event) => event.type === "coordinator.round.cancel_requested" && (event.payload as { round_id?: string })?.round_id === round_id)) {
      await session.events.append({ event_id: ulid(), session_id: req_id, type: "coordinator.round.cancel_requested", schema_version: "1",
        actor: { kind: "human", id: "local-human" }, correlation_id: round_id, payload: { round_id }, source: { adapter: "console-server" } });
    }
    const active = this.active.get(req_id);
    if (active?.round_id === round_id) {
      active.controller.abort();
      await active.promise;
    } else {
      const current = await this.get(req_id, round_id);
      if (current.status === "pending" || current.status === "running") await this.finishInterrupted(session, current, true);
    }
    return this.get(req_id, round_id);
  }

  /** 重启不重放付费调用；未落终态的轮次被明确标记，可新建轮次重新取快照。 */
  async recover(): Promise<void> {
    for (const req_id of await this.sessions.listIds()) {
      const session = await this.sessions.open(req_id);
      const events = await session.events.readOrdered();
      for (const round of projectRounds(events, req_id)) {
        if (round.status !== "pending" && round.status !== "running") continue;
        const cancelled = events.some((event) => event.type === "coordinator.round.cancel_requested" && (event.payload as { round_id?: string })?.round_id === round.round_id);
        await this.finishInterrupted(session, round, cancelled);
      }
    }
  }

  private async finishInterrupted(session: SessionHandle, round: CoordinationRoundView, cancelled: boolean): Promise<void> {
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1",
      actor: { kind: "system", id: "coordination-recovery" }, correlation_id: round.round_id,
      payload: { round_id: round.round_id, workflow_id: round.workflow_id, driver: round.driver,
        ...(round.workflow_revision !== null ? { workflow_revision: round.workflow_revision } : {}),
        ...(round.snapshot_id !== null ? { snapshot_id: round.snapshot_id } : {}),
        ...(round.input_hash !== null ? { input_hash: round.input_hash } : {}),
        ...(round.agent_configuration_hash !== null ? { agent_configuration_hash: round.agent_configuration_hash } : {}),
        ...(round.source_hash !== null ? { source_hash: round.source_hash } : {}),
        ...(round.verification_context_hash !== null ? { verification_context_hash: round.verification_context_hash } : {}),
        status: cancelled ? "cancelled" : "failed", proposal: null,
        error: cancelled ? "协调轮次已取消" : "server 中断了协调轮次，请基于最新快照重新协调",
        failure_stage: "interrupted", duration_ms: Math.max(0, Date.now() - Date.parse(round.requested_at)) },
      source: { adapter: "console-server" } });
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    for (const round of active) round.controller.abort();
    await Promise.all(active.map((round) => round.promise));
  }
}
