/** 独立协调轮次的后台生命周期；所有持久化状态均从事件流投影（ADR-0032）。 */
import { ulid } from "ulid";
import {
  CoordinatorRoundRequestedPayloadSchema, CoordinatorRoundStartedPayloadSchema,
  CoordinatorRoundCompletedPayloadSchema, createContextSessionAgent,
  CoordinatorRoundAdoptedPayloadSchema, coordinationInputHash, parseCoordinationProposal, readCoordinationSnapshot,
  readSessionEvents, SessionEventReadError, CoordinatorRoundAnsweredPayloadSchema, CoordinatorRoundAnswerRevokedPayloadSchema, readClarificationAnswers, currentClarificationAnswers, projectClarifications, MAX_CLARIFICATION_QUESTIONS,
  type AgentDriver, type EventEnvelope, type SessionHandle, type WorkflowDef,
} from "agent-cord";
import type { AnswerCoordinationInput, RevokeCoordinationAnswerInput, CoordinationRoundView, RunInfo, StartCoordinationInput } from "../contracts.js";
import { badRequest, conflict, internalError, notFound } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";
import type { RunService } from "./run-service.js";
import { readVerificationSource, verificationSourceInputs } from "./verification-inputs.js";
import { readCoordinationVerifications } from "./verification-context.js";
import { readCoordinationExecutionContext } from "./execution-context.js";

interface ActiveCoordination {
  round_id: string;
  controller: AbortController;
  promise: Promise<void>;
}

function projectRounds(events: readonly EventEnvelope[], req_id: string): CoordinationRoundView[] {
  const answers = readClarificationAnswers(events);
  const active_ids = new Set(currentClarificationAnswers(events).filter((answer) => answer.revoked_at === undefined).map((answer) => answer.event_id));
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
        snapshot_id: null, input_hash: null, agent_configuration_hash: null, source_hash: null, verification_context_hash: null, execution_context_hash: null,
        proposal: null, error: null, failure_stage: null,
        current: null, adoptable: false, adoption_reason: null, adopted_run_id: null, adopted_at: null,
        answer: null, answerable: false, answer_reason: null, answer_revocable: false,
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
        source_hash: payload.source_hash ?? round.source_hash, verification_context_hash: payload.verification_context_hash ?? round.verification_context_hash,
        execution_context_hash: payload.execution_context_hash ?? round.execution_context_hash });
      if (event.type === "coordinator.round.started") {
        round.status = "running";
        round.started_at = event.timestamp;
      } else {
        const completion = CoordinatorRoundCompletedPayloadSchema.parse(event.payload);
        Object.assign(round, { status: completion.status, proposal: completion.proposal, error: completion.error,
          failure_stage: completion.failure_stage ?? null, finished_at: event.timestamp });
        round.answer_reason = completion.proposal?.next_action.kind === "ask_human" && (completion.workflow_id !== round.workflow_id || event.correlation_id !== completion.round_id || completion.error !== null || completion.failure_stage !== undefined)
          ? "原问题完成事实不符合来源契约，请重新协调" : null;
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
  for (const answer of answers) {
    const round = rounds.get(answer.round_id);
    if (round !== undefined) {
      round.answer = { event_id: answer.event_id, choice: answer.choice, answered_at: answer.answered_at, completion_event_id: answer.completion_event_id,
        ...(answer.revoked_at === undefined ? {} : { revoked_at: answer.revoked_at, revocation_event_id: answer.revocation_event_id }) };
      round.answer_revocable = active_ids.has(answer.event_id);
    }
  }
  return [...rounds.values()].reverse();
}

export class CoordinationService {
  private readonly active = new Map<string, ActiveCoordination>();
  private readonly cancellation = new Map<string, Promise<CoordinationRoundView>>();
  private readonly storage_errors = new Map<string, string>();
  private readonly adoption = new Map<string, Promise<RunInfo>>();
  private readonly answering = new Map<string, { round_id: string; signature: string; promise: Promise<CoordinationRoundView> }>();
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
      await this.readEvents(session);
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
        read_execution_context: (def, session, revision) => readCoordinationExecutionContext(def, session, revision, this.options.runs),
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
    let rounds: CoordinationRoundView[];
    try { rounds = projectRounds(await this.readEvents(await this.sessions.open(req_id)), req_id); }
    catch (error) { if (error instanceof SessionEventReadError) throw conflict("协调澄清事实不可验证，请修复后重新核验"); throw error; }
    const active = this.active.get(req_id);
    const current = rounds.find((round) => round.round_id === active?.round_id);
    if (active !== undefined && current !== undefined && current.status !== "pending" && current.status !== "running") await active.promise;
    return rounds;
  }

  private async readEvents(session: SessionHandle): Promise<EventEnvelope[]> {
    try { return await readSessionEvents(session); }
    catch (error) {
      if (error instanceof SessionEventReadError) throw conflict("协调事件流不完整或包含其他需求事实，请修复后重新核验");
      throw error;
    }
  }

  private async inspect(round: CoordinationRoundView, def?: WorkflowDef, workflow_revision?: string): Promise<Pick<CoordinationRoundView, "current" | "adoptable" | "adoption_reason" | "answerable" | "answer_reason">> {
    const result = { current: null as boolean | null, adoptable: false, adoption_reason: null as string | null, answerable: false, answer_reason: null as string | null };
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
      const snapshot = await readCoordinationSnapshot(workflow, session, round.workflow_revision);
      const source_hash = await this.read_source_hash(workflow);
      const verifications = await readCoordinationVerifications(workflow, session, round.workflow_revision, this.options.runs);
      const execution_context = await readCoordinationExecutionContext(workflow, session, round.workflow_revision, this.options.runs);
      result.current = round.source_hash === source_hash && coordinationInputHash(workflow, snapshot, configuration_hash, undefined, source_hash, verifications, execution_context) === round.input_hash;
      if (!result.current) result.adoption_reason = "需求、源码、验证、进度或 Agent 配置已变化，请重新协调";
      else if (this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) result.adoption_reason = "绑定的 SDLC 版本已归档";
      else if (round.adopted_run_id !== null) result.adoption_reason = "提议已采用";
      else if (round.proposal.next_action.kind !== "advance") result.adoption_reason = "当前提议不启动 SDLC";
      else {
        parseCoordinationProposal(JSON.stringify(round.proposal), workflow, snapshot, verifications, execution_context);
        result.adoptable = true;
      }
      const action = round.proposal.next_action;
      if (action.kind === "ask_human") {
        if (round.answer != null) result.answer_reason = "该问题已答复";
        else if (round.answer_reason != null) result.answer_reason = round.answer_reason;
        else if (!result.current || this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) result.answer_reason = result.adoption_reason;
        else if ((snapshot.clarifications?.length ?? 0) >= MAX_CLARIFICATION_QUESTIONS && !snapshot.clarifications?.some((answer) => answer.question === action.question)) result.answer_reason = "当前澄清问题已达到容量上限";
        else { parseCoordinationProposal(JSON.stringify(round.proposal), workflow, snapshot, verifications, execution_context); result.answerable = true; result.answer_reason = null; }
      }
    } catch { result.adoption_reason = "无法验证当前协调依据，请刷新或重新协调"; }
    return result;
  }

  answer(req_id: string, round_id: string, input: AnswerCoordinationInput): Promise<CoordinationRoundView> {
    return this.mutate_answer(req_id, round_id, JSON.stringify({ kind: "answer", ...input }), () => this.answerOnce(req_id, round_id, input));
  }

  private mutate_answer(req_id: string, round_id: string, signature: string, write: () => Promise<CoordinationRoundView>): Promise<CoordinationRoundView> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    const pending = this.answering.get(req_id);
    if (pending !== undefined) return pending.round_id === round_id && pending.signature === signature ? pending.promise : Promise.reject(conflict("已有在途澄清操作，不能同时记录另一选择或撤回"));
    const operation = write().finally(() => { if (this.answering.get(req_id)?.promise === operation) this.answering.delete(req_id); });
    this.answering.set(req_id, { round_id, signature, promise: operation });
    return operation;
  }

  private async answerOnce(req_id: string, round_id: string, input: AnswerCoordinationInput): Promise<CoordinationRoundView> {
    const round = await this.get(req_id, round_id);
    if (round.answer != null) {
      if (round.answer.revoked_at !== undefined) throw conflict("旧答复已撤回，请重新协调后记录选择");
      if (round.answer.choice !== input.choice) throw conflict("该问题已有不同答复，请重新协调形成新的澄清问题");
      return round;
    }
    const action = round.proposal?.next_action;
    if (action?.kind !== "ask_human") throw conflict("该轮次没有可答复的澄清问题");
    if (!action.options.includes(input.choice)) throw badRequest("答复选择不属于问题选项");
    if (round.answerable !== true || round.input_hash === null || round.workflow_revision === null) throw conflict(round.answer_reason ?? round.adoption_reason ?? "当前问题不可答复，请重新协调");
    const session = await this.sessions.open(req_id);
    const events = await this.readEvents(session);
    const completion = [...events].reverse().find((event) => event.type === "coordinator.round.completed" && (event.payload as { round_id?: unknown } | null)?.round_id === round_id);
    const completed = CoordinatorRoundCompletedPayloadSchema.safeParse(completion?.payload);
    if (completion === undefined || !completed.success || completed.data.input_hash !== round.input_hash || completed.data.workflow_id !== round.workflow_id
      || completed.data.workflow_revision !== round.workflow_revision || completion.correlation_id !== round_id || completed.data.status !== "ok"
      || completed.data.error !== null || completed.data.failure_stage !== undefined) throw conflict("问题完成事实已变化，请重新协调");
    const current_action = completed.data.proposal?.next_action;
    if (current_action?.kind !== "ask_human" || current_action.question !== action.question || JSON.stringify(current_action.options) !== JSON.stringify(action.options)) throw conflict("澄清问题或选项已变化，请重新协调");
    const current = projectClarifications(events, { workflow_id: round.workflow_id, workflow_revision: round.workflow_revision });
    if (current.length >= MAX_CLARIFICATION_QUESTIONS && !current.some((answer) => answer.question === action.question)) throw conflict("当前澄清问题已达到容量上限");
    const payload = CoordinatorRoundAnsweredPayloadSchema.parse({ round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision,
      completion_event_id: completion.event_id, input_hash: round.input_hash, choice: input.choice });
    await session.events.append({ event_id: ulid(), session_id: req_id, type: "coordinator.round.answered", schema_version: "1", actor: { kind: "human", id: "local-human" },
      correlation_id: round_id, payload, source: { adapter: "console-server" } });
    return this.get(req_id, round_id);
  }

  revoke_answer(req_id: string, round_id: string, input: RevokeCoordinationAnswerInput): Promise<CoordinationRoundView> {
    return this.mutate_answer(req_id, round_id, JSON.stringify({ kind: "revoke", ...input }), () => this.revoke_answer_once(req_id, round_id, input));
  }

  private async revoke_answer_once(req_id: string, round_id: string, input: RevokeCoordinationAnswerInput): Promise<CoordinationRoundView> {
    const round = await this.get(req_id, round_id);
    if (round.answer == null || round.answer.event_id !== input.answer_event_id || round.workflow_revision === null) throw conflict("预期答复不存在或已变化，请刷新后重试");
    if (round.answer.revoked_at !== undefined) return round;
    if (round.answer_revocable !== true) throw conflict("该答复已被更新的同题选择替代");
    const session = await this.sessions.open(req_id); const events = await this.readEvents(session);
    const current = currentClarificationAnswers(events, { workflow_id: round.workflow_id, workflow_revision: round.workflow_revision });
    const answer = current.find((item) => item.event_id === input.answer_event_id && item.round_id === round_id);
    if (answer === undefined) throw conflict("当前同题答复已变化，请刷新后重试");
    if (answer.revoked_at !== undefined) return this.get(req_id, round_id);
    const payload = CoordinatorRoundAnswerRevokedPayloadSchema.parse({ round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision, answer_event_id: answer.event_id });
    await session.events.append({ event_id: ulid(), session_id: req_id, type: "coordinator.round.answer_revoked", schema_version: "1", actor: { kind: "human", id: "local-human" },
      correlation_id: round_id, payload, source: { adapter: "console-server" } });
    return this.get(req_id, round_id);
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
    try { return await this.cancelWithEvidence(req_id, round_id); }
    catch (error) {
      const active = this.active.get(req_id);
      // 明确取消必须收束当前调用；事实失败继续报告，不能伪造取消成功。
      if (active?.round_id === round_id) {
        active.controller.abort();
        await active.promise;
      }
      throw error;
    }
  }

  private async cancelWithEvidence(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    const round = await this.get(req_id, round_id);
    if (round.status !== "pending" && round.status !== "running") return round;
    const session = await this.sessions.open(req_id);
    const events = await this.readEvents(session);
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
      let events: EventEnvelope[];
      let rounds: CoordinationRoundView[];
      try { events = await readSessionEvents(session); rounds = projectRounds(events, req_id); }
      catch (error) {
        if (!(error instanceof SessionEventReadError)) throw error;
        this.options.onError?.(new SessionEventReadError(`需求 ${req_id} 的协调恢复未执行：${error.message}`));
        continue;
      }
      for (const round of rounds) {
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
        ...(round.execution_context_hash !== null ? { execution_context_hash: round.execution_context_hash } : {}),
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
    await Promise.allSettled([...this.answering.values()].map((answer) => answer.promise));
  }
}
