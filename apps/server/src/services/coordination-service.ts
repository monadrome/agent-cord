/** 独立协调轮次的后台生命周期；所有持久化状态均从事件流投影（ADR-0032）。 */
import { ulid } from "ulid";
import {
  CoordinatorRoundRequestedPayloadSchema, CoordinatorRoundStartedPayloadSchema,
  CoordinatorRoundCompletedPayloadSchema, createContextSessionAgent,
  type AgentDriver, type EventEnvelope, type SessionHandle,
} from "agent-cord";
import type { CoordinationRoundView, StartCoordinationInput } from "../contracts.js";
import { conflict, internalError, notFound } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";

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
        workflow_id: payload.workflow_id, driver: payload.driver, status: "pending",
        requested_at: event.timestamp, started_at: null, finished_at: null,
        snapshot_id: null, input_hash: null, agent_configuration_hash: null,
        proposal: null, error: null, failure_stage: null,
      });
    } else if (event.type === "coordinator.round.started" || event.type === "coordinator.round.completed") {
      const parsed = event.type === "coordinator.round.started" ? CoordinatorRoundStartedPayloadSchema.safeParse(event.payload) : CoordinatorRoundCompletedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) throw internalError("协调轮次事件不符合契约");
      const payload = parsed.data;
      const round = rounds.get(payload.round_id);
      if (round === undefined) continue; // 库调用轮次没有 server request 登记，不冒充 API 任务。
      Object.assign(round, { driver: payload.driver, snapshot_id: payload.snapshot_id ?? round.snapshot_id,
        input_hash: payload.input_hash ?? round.input_hash, agent_configuration_hash: payload.agent_configuration_hash ?? round.agent_configuration_hash });
      if (event.type === "coordinator.round.started") {
        round.status = "running";
        round.started_at = event.timestamp;
      } else {
        const completion = CoordinatorRoundCompletedPayloadSchema.parse(event.payload);
        Object.assign(round, { status: completion.status, proposal: completion.proposal, error: completion.error,
          failure_stage: completion.failure_stage ?? null, finished_at: event.timestamp });
      }
    }
  }
  return [...rounds.values()].reverse();
}

export class CoordinationService {
  private readonly active = new Map<string, ActiveCoordination>();
  private readonly cancellation = new Map<string, Promise<CoordinationRoundView>>();
  private readonly storage_errors = new Map<string, string>();
  private closing = false;

  constructor(private readonly sessions: SessionService, private readonly sdlcs: SdlcService,
    private readonly options: { workspaceRoot: string; resolver: () => (name: string) => AgentDriver; onError?: (error: unknown) => void }) {}

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
        payload: { round_id: active.round_id, workflow_id: versioned.def.metadata.id, driver: input.agent, sdlc_id: versioned.sdlc_id, sdlc_version: versioned.version },
        source: { adapter: "console-server" },
      });
      requested = true;
      resolve_ready(await this.get(req_id, active.round_id));
      await createContextSessionAgent({ resolveDriver: resolver, workspaceRoot: this.options.workspaceRoot }).coordinate(versioned.def, session, {
        round_id: active.round_id, agent: input.agent, signal: active.controller.signal,
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
    return projectRounds(await this.sessions.readEvents(req_id), req_id);
  }

  async get(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    if (this.storage_errors.has(round_id)) throw internalError("协调轮次事实写入失败，需要修复存储后恢复", this.storage_errors.get(round_id));
    const round = (await this.list(req_id)).find((item) => item.round_id === round_id);
    if (round === undefined) throw notFound(`协调轮次不存在：${round_id}`);
    return round;
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
        ...(round.snapshot_id !== null ? { snapshot_id: round.snapshot_id } : {}),
        ...(round.input_hash !== null ? { input_hash: round.input_hash } : {}),
        ...(round.agent_configuration_hash !== null ? { agent_configuration_hash: round.agent_configuration_hash } : {}),
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
