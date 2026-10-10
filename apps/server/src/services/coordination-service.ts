/** 独立协调轮次的后台生命周期；所有持久化状态均从事件流投影（ADR-0032）。 */
import { ulid } from "ulid";
import {
  CoordinatorRoundRequestedPayloadSchema, CoordinatorRoundStartedPayloadSchema,
  CoordinatorRoundCompletedPayloadSchema, createContextSessionAgent,
  CoordinatorRoundAdoptedPayloadSchema, coordinationInputHash, parseCoordinationProposal, readCoordinationSnapshot,
  GoalAttemptCompletedPayloadSchema, GoalBlockerTriggerSchema, type GoalBlockerTrigger, matchesWorkflowScope,
  GoalRetryAuthorizedPayloadSchema, readGoalRetryAuthorization, readGoalCoordinationRequest, canonicalJson, sha256Hex,
  readSessionEvents, SessionEventReadError, CoordinatorRoundAnsweredPayloadSchema, CoordinatorRoundAnswerRevokedPayloadSchema, readClarificationAnswers, currentClarificationAnswers, projectClarifications, MAX_CLARIFICATION_QUESTIONS,
  read_coordination_agents, type AgentDriver, type EventEnvelope, type SessionHandle, type WorkflowDef,
} from "agent-cord";
import type { AnswerCoordinationInput, RevokeCoordinationAnswerInput, CoordinationRoundView, RunInfo, StartCoordinationInput, RetryGoalInput, GoalRetryView, CoordinationRetryView } from "../contracts.js";
import { ApiError, badRequest, conflict, internalError, notFound } from "../errors.js";
import type { SessionService } from "./session-service.js";
import { DEFAULT_SDLC_ID, type SdlcService } from "./sdlc-service.js";
import type { GoalBlockedContext, RunService } from "./run-service.js";
import { readVerificationSource, verificationSourceInputs } from "./verification-inputs.js";
import { readCoordinationVerifications } from "./verification-context.js";
import { readCoordinationExecutionContext, goalUsageViews } from "./execution-context.js";

interface ActiveCoordination {
  round_id: string;
  controller: AbortController;
  promise: Promise<void>;
}
interface CoordinationRetryGuard {
  parent_round_id: string;
  input_hash: string;
  resolver: (name: string) => AgentDriver;
  validate(request_recorded: boolean): Promise<{ configuration_hash: string; coordination_input_hash: string }>;
}

function roundGoalBlocker(round: CoordinationRoundView): GoalBlockerTrigger | undefined {
  return round.trigger === undefined ? undefined : GoalBlockerTriggerSchema.parse({ node_id: round.node_id, run_id: round.run_id, goal_event_id: round.goal_event_id });
}
function eventPayload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

async function waitForRound(active: ActiveCoordination, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let cancel: () => void = () => {};
  const aborted = new Promise<void>(resolve => { cancel = resolve; signal.addEventListener("abort", cancel, { once: true }); });
  try { await Promise.race([active.promise, aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
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
      if (payload.trigger === "goal_blocked") {
        try { readGoalCoordinationRequest(events, payload.round_id); }
        catch { throw internalError("自动协调请求的 Goal 来源不可验证"); }
      }
      rounds.set(payload.round_id, {
        round_id: payload.round_id, req_id, sdlc_id: payload.sdlc_id, sdlc_version: payload.sdlc_version,
        workflow_id: payload.workflow_id, driver: payload.driver, agent: payload.driver, status: "pending",
        workflow_revision: payload.workflow_revision ?? null,
        requested_at: event.timestamp, started_at: null, finished_at: null,
        snapshot_id: null, input_hash: null, agent_configuration_hash: null, source_hash: null, verification_context_hash: null, execution_context_hash: null, agent_context_hash: null,
        proposal: null, error: null, failure_stage: null,
        current: null, adoptable: false, adoption_reason: null, adopted_run_id: null, adopted_at: null,
        answer: null, answerable: false, answer_reason: null, answer_revocable: false,
        ...(payload.trigger === undefined ? {} : { trigger: payload.trigger, run_id: payload.run_id, node_id: payload.node_id, goal_event_id: payload.goal_event_id }),
        ...(payload.retry_of_round_id === undefined ? {} : { retry_of_round_id: payload.retry_of_round_id }),
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
        execution_context_hash: payload.execution_context_hash ?? round.execution_context_hash, agent_context_hash: payload.agent_context_hash ?? round.agent_context_hash });
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
  private readonly escalations = new Map<string, Promise<void>>();
  private readonly retrying = new Map<string, { signature: string; promise: Promise<RunInfo> }>();
  private readonly coordination_retrying = new Map<string, { signature: string; promise: Promise<CoordinationRoundView> }>();
  private readonly closing_controller = new AbortController();
  private closing = false;

  constructor(private readonly sessions: SessionService, private readonly sdlcs: SdlcService,
    private readonly options: { workspaceRoot: string; resolver: () => (name: string) => AgentDriver; runs: RunService; onError?: (error: unknown) => void }) {}

  start(req_id: string, input: StartCoordinationInput, goal_blocker?: GoalBlockerTrigger): Promise<CoordinationRoundView> {
    return this.startRound(req_id, input, goal_blocker);
  }

  private startRound(req_id: string, input: StartCoordinationInput, goal_blocker?: GoalBlockerTrigger, retry?: CoordinationRetryGuard): Promise<CoordinationRoundView> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    if (this.active.has(req_id)) return Promise.reject(conflict(`需求 ${req_id} 已有在途协调轮次`));
    const active: ActiveCoordination = { round_id: ulid(), controller: new AbortController(), promise: Promise.resolve() };
    this.active.set(req_id, active);
    let resolve_ready!: (view: CoordinationRoundView) => void;
    let reject_ready!: (error: unknown) => void;
    const ready = new Promise<CoordinationRoundView>((resolve, reject) => { resolve_ready = resolve; reject_ready = reject; });
    let requested = false;
    let dispatched = false;
    active.promise = (async () => {
      const resolver = retry?.resolver ?? this.options.resolver();
      const session = await this.sessions.open(req_id);
      await this.readEvents(session);
      const versioned = await this.sdlcs.get(input.sdlc_id ?? DEFAULT_SDLC_ID, input.sdlc_version);
      if (this.sdlcs.isArchived(versioned.sdlc_id, versioned.version)) throw conflict("归档 SDLC 版本不能启动新协调轮次");
      if (goal_blocker !== undefined) await this.validateGoalBlocker(req_id, input, goal_blocker, versioned.def, versioned.workflow_revision, retry !== undefined);
      const retry_state = await retry?.validate(false);
      await session.events.append({
        event_id: ulid(), session_id: req_id, type: "coordinator.round.requested", schema_version: "1",
        actor: goal_blocker === undefined || retry !== undefined ? { kind: "human", id: "local-human" } : { kind: "system", id: "goal-supervisor" }, correlation_id: active.round_id,
        payload: CoordinatorRoundRequestedPayloadSchema.parse({ round_id: active.round_id, workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, driver: input.agent, sdlc_id: versioned.sdlc_id, sdlc_version: versioned.version,
          ...(retry === undefined ? {} : { retry_of_round_id: retry.parent_round_id, retry_input_hash: retry.input_hash, retry_configuration_hash: retry_state!.configuration_hash }),
          ...(goal_blocker === undefined ? {} : { trigger: "goal_blocked", ...goal_blocker }) }),
        source: { adapter: "console-server" },
      });
      requested = true;
      await retry?.validate(true);
      resolve_ready(await this.get(req_id, active.round_id));
      dispatched = true;
      await createContextSessionAgent({ resolveDriver: resolver, workspaceRoot: this.options.workspaceRoot,
        ...(retry === undefined ? {} : { expected_input_hash: retry_state!.coordination_input_hash }),
        read_source_hash: (def) => this.read_source_hash(def),
        read_verifications: (def, session, revision) => readCoordinationVerifications(def, session, revision, this.options.runs),
        read_execution_context: (def, session, revision) => readCoordinationExecutionContext(def, session, revision, this.options.runs),
        read_agents: async def => read_coordination_agents(def, resolver),
      }).coordinate(versioned.def, session, {
        round_id: active.round_id, agent: input.agent, signal: active.controller.signal,
        workflow_revision: versioned.workflow_revision,
        ...(goal_blocker === undefined ? {} : { goal_blocker }),
        ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
      });
    })().catch(async (error: unknown) => {
      if (!requested) reject_ready(error);
      else if (retry !== undefined && !dispatched) {
        try {
          const session = await this.sessions.open(req_id);
          await this.finishInterrupted(session, await this.readRound(req_id, active.round_id), false);
          reject_ready(error);
        } catch (failure) {
          this.storage_errors.set(active.round_id, failure instanceof Error ? failure.message : "协调事实写入失败");
          reject_ready(failure); this.options.onError?.(failure);
        }
      }
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
    return Promise.all(rounds.map(async (round) => ({ ...round, ...await this.inspect(round), ...await this.inspectGoalRetry(round), ...await this.inspectCoordinationRetry(round), ...await this.inspectGoalUsage(round) })));
  }

  async get(req_id: string, round_id: string): Promise<CoordinationRoundView> {
    if (this.storage_errors.has(round_id)) throw internalError("协调轮次事实写入失败，需要修复存储后恢复", this.storage_errors.get(round_id));
    const round = await this.readRound(req_id, round_id);
    return { ...round, ...await this.inspect(round), ...await this.inspectGoalRetry(round), ...await this.inspectCoordinationRetry(round), ...await this.inspectGoalUsage(round) };
  }

  private async inspectGoalUsage(round: CoordinationRoundView): Promise<Pick<CoordinationRoundView, "goal_usage">> {
    const binding = await this.sdlcs.get(round.sdlc_id, round.sdlc_version);
    if (!binding.def.spec.nodes.some(node => node.run?.goal?.usage_budget !== undefined) || binding.workflow_revision !== round.workflow_revision) return {};
    const latest = await this.options.runs.latestRun(round.req_id);
    if (latest !== null && latest.workflow_revision !== binding.workflow_revision) return { goal_usage: [] };
    const session = await this.sessions.open(round.req_id);
    return { goal_usage: goalUsageViews(await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, this.options.runs)) };
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

  private async inspect(round: CoordinationRoundView, def?: WorkflowDef, workflow_revision?: string, fixed_resolver?: (name: string) => AgentDriver): Promise<Pick<CoordinationRoundView, "current" | "adoptable" | "adoption_reason" | "answerable" | "answer_reason">> {
    const result = { current: null as boolean | null, adoptable: false, adoption_reason: null as string | null, answerable: false, answer_reason: null as string | null };
    if (round.status !== "ok" || round.proposal === null) return result;
    try {
      const versioned = def === undefined ? await this.sdlcs.get(round.sdlc_id, round.sdlc_version) : { def, workflow_revision };
      const workflow = versioned.def;
      if (round.workflow_revision === null) { result.adoption_reason = "该轮次缺少执行版本，请重新协调"; return result; }
      if (round.workflow_revision !== versioned.workflow_revision) { result.current = false; result.adoption_reason = "绑定的工作流定义已变化，请发布新版本并重新协调"; return result; }
      if (workflow.metadata.id !== round.workflow_id) throw new Error("workflow 不匹配");
      const resolver = fixed_resolver ?? this.options.resolver();
      const configuration_hash = resolver(round.agent).configuration_hash;
      if (round.agent_configuration_hash === null || configuration_hash === undefined) {
        result.adoption_reason = "无法验证 Agent 配置身份，请重新协调";
        return result;
      }
      const session = await this.sessions.open(round.req_id);
      const snapshot = await readCoordinationSnapshot(workflow, session, round.workflow_revision);
      const source_hash = await this.read_source_hash(workflow);
      const verifications = await readCoordinationVerifications(workflow, session, round.workflow_revision, this.options.runs);
      const execution_context = await readCoordinationExecutionContext(workflow, session, round.workflow_revision, this.options.runs);
      const goal_blocker = roundGoalBlocker(round);
      const agents = read_coordination_agents(workflow, resolver);
      result.current = round.source_hash === source_hash && round.agent_context_hash === sha256Hex(canonicalJson(agents))
        && coordinationInputHash(workflow, snapshot, configuration_hash, undefined, source_hash, verifications, execution_context, goal_blocker, agents) === round.input_hash;
      if (!result.current) result.adoption_reason = "需求、源码、验证、进度或 Agent 配置已变化，请重新协调";
      else if (this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) result.adoption_reason = "绑定的 SDLC 版本已归档";
      else if (round.adopted_run_id !== null) result.adoption_reason = "提议已采用";
      else if (round.proposal.next_action.kind !== "advance") result.adoption_reason = "当前提议不启动 SDLC";
      else {
        parseCoordinationProposal(JSON.stringify(round.proposal), workflow, snapshot, verifications, execution_context, goal_blocker, agents);
        result.adoptable = true;
      }
      const action = round.proposal.next_action;
      if (action.kind === "ask_human") {
        if (round.answer != null) result.answer_reason = "该问题已答复";
        else if (round.answer_reason != null) result.answer_reason = round.answer_reason;
        else if (!result.current || this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) result.answer_reason = result.adoption_reason;
        else if ((snapshot.clarifications?.length ?? 0) >= MAX_CLARIFICATION_QUESTIONS && !snapshot.clarifications?.some((answer) => answer.question === action.question)) result.answer_reason = "当前澄清问题已达到容量上限";
        else { parseCoordinationProposal(JSON.stringify(round.proposal), workflow, snapshot, verifications, execution_context, goal_blocker, agents); result.answerable = true; result.answer_reason = null; }
      }
    } catch { result.adoption_reason = "无法验证当前协调依据，请刷新或重新协调"; }
    return result;
  }

  answer(req_id: string, round_id: string, input: AnswerCoordinationInput): Promise<CoordinationRoundView> {
    return this.mutate_answer(req_id, round_id, JSON.stringify({ kind: "answer", ...input }), () => this.answerOnce(req_id, round_id, input));
  }

  private mutate_answer(req_id: string, round_id: string, signature: string, write: () => Promise<CoordinationRoundView>): Promise<CoordinationRoundView> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    if (this.retrying.has(req_id)) return Promise.reject(conflict("Goal 续跑授权正在记录，不能并发修改答复"));
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

  private async inspectGoalRetry(round: CoordinationRoundView): Promise<{ goal_retry?: GoalRetryView }> {
    if (round.trigger !== "goal_blocked") return {};
    const view: GoalRetryView = { available: false, reason: null, input_hash: null, max_attempts: null, timeout_ms: null, run_id: null };
    try {
      const events = await this.readEvents(await this.sessions.open(round.req_id));
      const accepted = this.findGoalRetry(events, round.round_id);
      if (accepted !== null) {
        await this.assertGoalRetryBudget(round, accepted);
        Object.assign(view, { run_id: accepted.run_id, input_hash: accepted.input_hash, max_attempts: accepted.max_attempts, timeout_ms: accepted.timeout_ms, reason: "本轮 Goal 已重新执行" });
      } else {
        const state = await this.readGoalRetryState(round);
        Object.assign(view, { available: !this.options.runs.isActive(round.req_id), reason: this.options.runs.isActive(round.req_id) ? "原 run 正在收尾，请稍后刷新" : null,
          input_hash: state.input_hash, max_attempts: state.goal.max_attempts, timeout_ms: state.goal.timeout_ms });
      }
    } catch (error) { view.reason = error instanceof Error ? error.message : "无法核验 Goal 续跑依据"; }
    return { goal_retry: view };
  }

  private findGoalRetry(events: readonly EventEnvelope[], round_id: string) {
    const matches = events.filter(event => event.type === "goal.retry.authorized" && typeof event.payload === "object"
      && event.payload !== null && (event.payload as Record<string, unknown>)["round_id"] === round_id);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw conflict("本轮 Goal 存在重复授权，拒绝继续");
    const auth = GoalRetryAuthorizedPayloadSchema.parse(matches[0]!.payload);
    if (readGoalRetryAuthorization(events, auth.run_id)?.event_id !== matches[0]!.event_id) throw conflict("Goal 续跑授权不可验证");
    return auth;
  }

  private async assertGoalRetryBudget(round: CoordinationRoundView, auth: ReturnType<typeof GoalRetryAuthorizedPayloadSchema.parse>): Promise<void> {
    const versioned = await this.sdlcs.get(round.sdlc_id, round.sdlc_version);
    const goal = versioned.def.spec.nodes.find(node => node.id === auth.node_id)?.run?.goal;
    if (round.workflow_revision !== versioned.workflow_revision || !matchesWorkflowScope(auth, { workflow_id: round.workflow_id, workflow_revision: versioned.workflow_revision })
      || goal === undefined || goal.max_attempts !== auth.max_attempts || goal.timeout_ms !== auth.timeout_ms) throw conflict("Goal 续跑授权预算与发布版本不匹配");
  }

  private async readGoalRetryState(round: CoordinationRoundView, pending_run_id?: string, resolver = this.options.resolver()) {
    if (round.trigger !== "goal_blocked" || round.status !== "ok" || round.proposal?.next_action.kind !== "ask_human"
      || round.workflow_revision === null || round.answer_reason != null) throw conflict("当前轮次不是有效的 Goal 人工问题");
    const trigger = roundGoalBlocker(round)!;
    const versioned = await this.sdlcs.get(round.sdlc_id, round.sdlc_version);
    if (versioned.workflow_revision !== round.workflow_revision || this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) throw conflict("绑定的 SDLC 已变化或归档，不能续跑");
    const session = await this.sessions.open(round.req_id); const events = await this.readEvents(session);
    const latest_run = await this.options.runs.latestRun(round.req_id, events);
    const expected_run = pending_run_id ?? trigger.run_id;
    const unlaunched_retry = pending_run_id === undefined && latest_run?.status === "failed" && latest_run.goal_retry_round_id === round.round_id
      && !events.some(event => ["goal.retry.authorized", "agent.task.started", "goal.attempt.started"].includes(event.type)
        && typeof event.payload === "object" && event.payload !== null && (event.payload as Record<string, unknown>)["run_id"] === latest_run.run_id);
    if ((!unlaunched_retry && latest_run?.run_id !== expected_run) || (pending_run_id === undefined ? latest_run?.status !== "failed" : latest_run?.status !== "running"
      || latest_run.goal_retry_round_id !== round.round_id)) throw conflict("原 Goal 运行已变化，不能授权旧卡点");
    const old_run = await this.options.runs.getRun(trigger.run_id);
    if (old_run.status !== "failed" || old_run.workflow_revision !== round.workflow_revision) throw conflict("原 Goal 不再是绑定版本的 failed run");
    const node = versioned.def.spec.nodes.find(item => item.id === trigger.node_id);
    const goal = node?.run?.goal;
    if (node === undefined || goal === undefined || goal.supervisor_agent !== round.agent) throw conflict("Goal 或 supervisor 定义已变化");
    const blocker = events.filter(event => ["goal.attempt.started", "goal.attempt.completed"].includes(event.type)
      && matchesWorkflowScope(event.payload, { workflow_id: versioned.def.metadata.id, workflow_revision: round.workflow_revision! })
      && event.payload["run_id"] === trigger.run_id && event.payload["node_id"] === trigger.node_id).at(-1);
    const blocked = GoalAttemptCompletedPayloadSchema.safeParse(blocker?.payload);
    if (blocker?.event_id !== trigger.goal_event_id || blocker.type !== "goal.attempt.completed" || blocker.correlation_id !== trigger.node_id
      || !blocked.success || blocked.data.status !== "blocked") throw conflict("Goal 阻塞事实已变化，不能续跑旧卡点");
    const answers = currentClarificationAnswers(events, { workflow_id: versioned.def.metadata.id, workflow_revision: round.workflow_revision });
    const answer = answers.find(item => item.round_id === round.round_id && item.revoked_at === undefined);
    if (answer === undefined || round.answer?.event_id !== answer.event_id) throw conflict("Goal 续跑需要当前未撤回的人工答复");
    const supervisor_hash = resolver(round.agent).configuration_hash;
    const worker_hash = resolver(node.run!.agent).configuration_hash;
    if (supervisor_hash === undefined || supervisor_hash !== round.agent_configuration_hash || worker_hash === undefined) throw conflict("无法核验本轮 supervisor 或 worker 配置，请重新协调");
    const assert_current = () => {
      const current = this.options.resolver();
      if (current(round.agent).configuration_hash !== supervisor_hash || current(node.run!.agent).configuration_hash !== worker_hash) throw conflict("Goal 续跑 agent 配置已变化，请刷新后重新授权");
    };
    assert_current();
    const input = await this.options.runs.readNodeInput(versioned.def, node, session, worker_hash, round.workflow_revision);
    assert_current();
    const input_hash = sha256Hex(canonicalJson({ domain: "cord.goal-retry-input.v1", req_id: round.req_id, round_id: round.round_id,
      blocker: trigger, blocked: blocked.data, answer_event_id: answer.event_id, completion_event_id: answer.completion_event_id,
      node_input_hash: input.input_hash, worker_hash, supervisor_hash, max_attempts: goal.max_attempts, timeout_ms: goal.timeout_ms }));
    return { input_hash, answer, goal, agent_configuration_hash: worker_hash, supervisor_configuration_hash: supervisor_hash, node_input_hash: input.input_hash };
  }

  retry_goal(req_id: string, round_id: string, input: RetryGoalInput): Promise<RunInfo> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    if (this.answering.has(req_id)) return Promise.reject(conflict("已有在途答复修改，不能同时授权续跑"));
    const signature = JSON.stringify({ round_id, ...input });
    const pending = this.retrying.get(req_id);
    if (pending !== undefined) return pending.signature === signature ? pending.promise : Promise.reject(conflict("已有另一项 Goal 续跑授权正在处理"));
    const operation = this.retryGoalOnce(req_id, round_id, input).finally(() => { if (this.retrying.get(req_id)?.promise === operation) this.retrying.delete(req_id); });
    this.retrying.set(req_id, { signature, promise: operation });
    return operation;
  }

  retry_coordination(req_id: string, round_id: string, input_hash: string): Promise<CoordinationRoundView> {
    if (this.closing) return Promise.reject(conflict("服务正在关闭"));
    const signature = JSON.stringify([round_id, input_hash]);
    const pending = this.coordination_retrying.get(req_id);
    if (pending !== undefined) return pending.signature === signature ? pending.promise : Promise.reject(conflict("已有另一项协调重试正在记录"));
    const operation = this.retry_coordination_once(req_id, round_id, input_hash).finally(() => {
      if (this.coordination_retrying.get(req_id)?.promise === operation) this.coordination_retrying.delete(req_id);
    });
    this.coordination_retrying.set(req_id, { signature, promise: operation });
    return operation;
  }

  private async retry_coordination_once(req_id: string, round_id: string, input_hash: string): Promise<CoordinationRoundView> {
    const resolver = this.options.resolver();
    const round = await this.readRound(req_id, round_id);
    const events = await this.readEvents(await this.sessions.open(req_id));
    const child = events.find(event => event.type === "coordinator.round.requested" && eventPayload(event)["retry_of_round_id"] === round_id);
    if (child !== undefined) {
      const request = CoordinatorRoundRequestedPayloadSchema.parse(child.payload);
      readGoalCoordinationRequest(events, request.round_id);
      if (request.retry_input_hash !== input_hash) throw conflict("原轮次已使用不同依据重试，请查看新轮次");
      return this.get(req_id, request.round_id);
    }
    const state = await this.readCoordinationRetryState(round, resolver);
    if (state.input_hash !== input_hash) throw conflict("协调重试依据已变化，请刷新后重试");
    return this.startRound(req_id, { agent: round.agent, sdlc_id: round.sdlc_id, sdlc_version: round.sdlc_version,
      ...(state.timeout_ms === undefined ? {} : { timeout_ms: state.timeout_ms }) }, roundGoalBlocker(round), {
      parent_round_id: round_id, input_hash, resolver,
      validate: async request_recorded => {
        const current = await this.readCoordinationRetryState(await this.readRound(req_id, round_id), resolver, request_recorded);
        if (current.input_hash !== input_hash) throw conflict("协调重试依据在记录期间已变化，请刷新");
        return current;
      },
    });
  }

  private async inspectCoordinationRetry(round: CoordinationRoundView): Promise<{ coordination_retry?: CoordinationRetryView }> {
    if (round.trigger !== "goal_blocked") return {};
    const view: CoordinationRetryView = { available: false, reason: null, input_hash: null, parent_round_id: round.round_id, child_round_id: null };
    try {
      const events = await this.readEvents(await this.sessions.open(round.req_id));
      const child = events.find(event => event.type === "coordinator.round.requested" && eventPayload(event)["retry_of_round_id"] === round.round_id);
      if (child !== undefined) {
        const request = CoordinatorRoundRequestedPayloadSchema.parse(child.payload); readGoalCoordinationRequest(events, request.round_id);
        view.child_round_id = request.round_id; view.reason = "本轮已重试，请查看新轮次";
      } else {
        const state = await this.readCoordinationRetryState(round, this.options.resolver());
        view.input_hash = state.input_hash; view.available = !this.active.has(round.req_id);
        view.reason = view.available ? null : "已有在途协调，请等待收束";
      }
    } catch (error) { view.reason = error instanceof Error ? error.message : "协调重试依据不可验证"; }
    return { coordination_retry: view };
  }

  private async readCoordinationRetryState(round: CoordinationRoundView, resolver: (name: string) => AgentDriver, request_recorded = false) {
    if (round.trigger !== "goal_blocked" || round.run_id === undefined || round.node_id === undefined || round.goal_event_id === undefined) throw conflict("只有 Goal 自动升级轮次可以重试协调");
    const stale = round.status === "ok" && (await this.inspect(round)).current === false;
    if (!(stale || ["failed", "timeout", "cancelled", "stale"].includes(round.status))) throw conflict("当前协调轮次未进入可重试终态");
    if (round.answer !== null || round.goal_retry?.run_id !== null && round.goal_retry?.run_id !== undefined) throw conflict("当前轮次已有人工答复或 Goal 续跑，不重复协调");
    const configuration_hash = resolver(round.agent).configuration_hash;
    if (configuration_hash === undefined) throw conflict("协调 Agent 配置身份不可验证");
    const versioned = await this.sdlcs.get(round.sdlc_id, round.sdlc_version);
    if (versioned.workflow_revision !== round.workflow_revision || this.sdlcs.isArchived(round.sdlc_id, round.sdlc_version)) throw conflict("绑定流程已变化或归档，不能重试协调");
    const session = await this.sessions.open(round.req_id); const events = await this.readEvents(session);
    readGoalCoordinationRequest(events, round.round_id);
    const trigger = { run_id: round.run_id, node_id: round.node_id, goal_event_id: round.goal_event_id } satisfies GoalBlockerTrigger;
    await this.validateGoalBlocker(round.req_id, { agent: round.agent }, trigger, versioned.def, versioned.workflow_revision, true);
    if (this.options.runs.isActive(round.req_id)) throw conflict("原 Goal 执行体仍在收尾，不能重试协调");
    const lineage = projectRounds(events, round.req_id).filter(item => item.trigger === "goal_blocked" && item.goal_event_id === round.goal_event_id);
    const latest = lineage[0];
    if (latest?.round_id !== round.round_id && !(request_recorded && latest?.retry_of_round_id === round.round_id && latest.status === "pending")) throw conflict("该 blocker 已有更新轮次，请查看最新轮次");
    if (lineage.some(item => item.answer !== null) || events.some(event => event.type === "goal.retry.authorized" && eventPayload(event)["goal_event_id"] === round.goal_event_id)) throw conflict("该 blocker 已有答复或执行授权，不重复协调");
    const completion = events.filter(event => event.type === "coordinator.round.completed" && eventPayload(event)["round_id"] === round.round_id).at(-1);
    if (completion === undefined) throw conflict("原协调轮次缺少终态事实");
    const snapshot = await readCoordinationSnapshot(versioned.def, session, versioned.workflow_revision);
    const source_hash = await this.read_source_hash(versioned.def);
    const verifications = await readCoordinationVerifications(versioned.def, session, versioned.workflow_revision, this.options.runs);
    const execution = await readCoordinationExecutionContext(versioned.def, session, versioned.workflow_revision, this.options.runs);
    const timeout_ms = versioned.def.spec.nodes.find(node => node.id === round.node_id)?.run?.goal?.supervisor_timeout_ms;
    const agents = read_coordination_agents(versioned.def, resolver);
    const coordination_input_hash = coordinationInputHash(versioned.def, snapshot, configuration_hash, undefined, source_hash, verifications, execution, trigger, agents);
    const input_hash = sha256Hex(canonicalJson({ domain: "cord.coordination-retry-input.v1", parent_round_id: round.round_id, completion_event_id: completion.event_id,
      coordination_input_hash, timeout_ms: timeout_ms ?? null }));
    if (!request_recorded && this.options.resolver()(round.agent).configuration_hash !== configuration_hash) throw conflict("协调配置已变化，请刷新后重试");
    return { input_hash, configuration_hash, coordination_input_hash, timeout_ms };
  }

  private async retryGoalOnce(req_id: string, round_id: string, input: RetryGoalInput): Promise<RunInfo> {
    const session = await this.sessions.open(req_id); const events = await this.readEvents(session);
    const round = await this.readRound(req_id, round_id);
    const previous = this.findGoalRetry(events, round_id);
    if (previous !== null) {
      await this.assertGoalRetryBudget(round, previous);
      if (previous.answer_event_id !== input.answer_event_id || previous.input_hash !== input.input_hash) throw conflict("本轮已使用不同依据授权续跑，请查看已启动 run");
      return this.options.runs.getRun(previous.run_id);
    }
    const driverResolver = this.options.resolver();
    const check = async (pending_run_id?: string) => {
      const current = await this.readRound(req_id, round_id);
      const state = await this.readGoalRetryState(current, pending_run_id, driverResolver);
      if (state.answer.event_id !== input.answer_event_id || state.input_hash !== input.input_hash) throw conflict("Goal 续跑依据已变化，请刷新后重新授权");
      return state;
    };
    await check();
    return this.options.runs.start(req_id, round.sdlc_id, round.sdlc_version, {
      goal_retry_round_id: round_id,
      driverResolver,
      validate: async () => { await check(); },
      record: async (current_session, run_id) => {
        const state = await check(run_id);
        const trigger = roundGoalBlocker(round)!;
        const payload = GoalRetryAuthorizedPayloadSchema.parse({ round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision,
          run_id, failed_run_id: trigger.run_id, node_id: trigger.node_id, goal_event_id: trigger.goal_event_id, answer_event_id: input.answer_event_id,
          input_hash: input.input_hash, max_attempts: state.goal.max_attempts, timeout_ms: state.goal.timeout_ms,
          agent_configuration_hash: state.agent_configuration_hash, supervisor_configuration_hash: state.supervisor_configuration_hash, node_input_hash: state.node_input_hash });
        await current_session.events.append({ event_id: ulid(), session_id: req_id, type: "goal.retry.authorized", schema_version: "1",
          actor: { kind: "human", id: "local-human" }, correlation_id: round_id, payload, source: { adapter: "console-server" } });
      },
    });
  }

  /** 以持久化 request 去重；已有轮次结束后再核验 blocker，避免丢失升级。 */
  escalateGoalBlocker(context: GoalBlockedContext): Promise<void> {
    if (this.closing) return Promise.resolve();
    const signal = context.signal === undefined ? this.closing_controller.signal : AbortSignal.any([context.signal, this.closing_controller.signal]);
    const key = JSON.stringify([context.req_id, context.goal_event_id]);
    const pending = this.escalations.get(key);
    if (pending !== undefined) return pending;
    const operation = (async () => {
      for (;;) {
        while (this.active.has(context.req_id)) {
          await waitForRound(this.active.get(context.req_id)!, signal);
          if (signal.aborted) return;
        }
        const session = await this.sessions.open(context.req_id);
        const events = await this.readEvents(session);
        for (const event of events) if (event.type === "coordinator.round.requested") {
          const request = CoordinatorRoundRequestedPayloadSchema.parse(event.payload);
          if (request.trigger === "goal_blocked" && request.goal_event_id === context.goal_event_id) return;
        }
        const run = await this.options.runs.latestRun(context.req_id, events);
        if (run?.run_id !== context.run_id || run.status !== "failed" || run.workflow_revision !== context.workflow_revision) return;
        if (signal.aborted) return;
        if (this.active.has(context.req_id)) continue;
        await this.start(context.req_id, { agent: context.supervisor_agent, sdlc_id: context.sdlc_id, sdlc_version: context.sdlc_version,
          ...(context.supervisor_timeout_ms === undefined ? {} : { timeout_ms: context.supervisor_timeout_ms }) },
        { node_id: context.node_id, run_id: context.run_id, goal_event_id: context.goal_event_id });
        return;
      }
    })().finally(() => { if (this.escalations.get(key) === operation) this.escalations.delete(key); });
    this.escalations.set(key, operation);
    return operation;
  }

  private async validateGoalBlocker(req_id: string, input: StartCoordinationInput, trigger: GoalBlockerTrigger, def: WorkflowDef, workflow_revision: string, allow_existing_request = false): Promise<void> {
    const source = GoalBlockerTriggerSchema.parse(trigger);
    const events = await this.readEvents(await this.sessions.open(req_id));
    if (!allow_existing_request && events.some(event => {
      if (event.type !== "coordinator.round.requested") return false;
      const request = CoordinatorRoundRequestedPayloadSchema.parse(event.payload);
      return request.trigger === "goal_blocked" && request.goal_event_id === source.goal_event_id;
    })) throw conflict("该 Goal blocker 已请求协调，不重复调用 supervisor");
    const run = await this.options.runs.latestRun(req_id, events);
    const node = def.spec.nodes.find(item => item.id === source.node_id);
    if (run?.run_id !== source.run_id || run.status !== "failed" || run.workflow_revision !== workflow_revision
      || node?.run?.goal?.supervisor_agent !== input.agent) throw conflict("自动 Goal 升级的运行或 supervisor 已变化");
    const scope = { workflow_id: def.metadata.id, workflow_revision };
    const event = events.filter(item => ["goal.attempt.started", "goal.attempt.completed"].includes(item.type)
      && matchesWorkflowScope(item.payload, scope) && item.payload["run_id"] === source.run_id && item.payload["node_id"] === source.node_id).at(-1);
    const parsed = GoalAttemptCompletedPayloadSchema.safeParse(event?.payload);
    if (event?.event_id !== source.goal_event_id || event.type !== "goal.attempt.completed" || event.correlation_id !== source.node_id
      || !parsed.success || parsed.data.status !== "blocked" || event.actor.kind !== "system" || event.source.adapter !== "goal-runner") throw conflict("自动 Goal 升级的 blocker 来源不符合契约");
  }

  /** 冷恢复只补没有请求事实的 blocker；已开始的模型调用不重放。 */
  async recoverGoalBlockers(): Promise<void> {
    for (const req_id of await this.sessions.listIds()) {
      try {
        const session = await this.sessions.open(req_id); const events = await this.readEvents(session);
        const run = await this.options.runs.latestRun(req_id, events);
        if (run === null || run.status !== "failed" || run.workflow_revision == null) continue;
        const versioned = await this.sdlcs.get(run.sdlc_id, run.sdlc_version);
        if (versioned.workflow_revision !== run.workflow_revision || this.sdlcs.isArchived(run.sdlc_id, run.sdlc_version)) continue;
        for (const node of versioned.def.spec.nodes) {
          const goal = node.run?.goal;
          if (goal?.supervisor_agent === undefined) continue;
          const event = events.filter(item => ["goal.attempt.started", "goal.attempt.completed"].includes(item.type)
            && matchesWorkflowScope(item.payload, { workflow_id: versioned.def.metadata.id, workflow_revision: run.workflow_revision ?? undefined })
            && item.payload["run_id"] === run.run_id && item.payload["node_id"] === node.id).at(-1);
          const value = GoalAttemptCompletedPayloadSchema.safeParse(event?.payload);
          if (event === undefined || !value.success || value.data.status !== "blocked") continue;
          await this.escalateGoalBlocker({ req_id, run_id: run.run_id, sdlc_id: run.sdlc_id, sdlc_version: run.sdlc_version,
            workflow_id: versioned.def.metadata.id, workflow_revision: run.workflow_revision, node_id: node.id, goal_event_id: event.event_id,
            supervisor_agent: goal.supervisor_agent, ...(goal.supervisor_timeout_ms === undefined ? {} : { supervisor_timeout_ms: goal.supervisor_timeout_ms }) });
        }
      } catch (error) { this.options.onError?.(error); }
    }
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
    const resolver = this.options.resolver();
    let workflow: WorkflowDef | undefined;
    const assert_agents = (def: WorkflowDef) => {
      const captured = sha256Hex(canonicalJson(read_coordination_agents(def, resolver)));
      const latest = sha256Hex(canonicalJson(read_coordination_agents(def, this.options.resolver())));
      if (captured !== round.agent_context_hash || latest !== captured) throw conflict("流程Agent配置已变化，请重新协调");
    };
    return this.options.runs.start(req_id, round.sdlc_id, round.sdlc_version, {
      coordination_round_id: round_id,
      driverResolver: resolver,
      validate: async (_session, def, workflow_revision) => {
        workflow = def; assert_agents(def);
        const current = await this.readRound(req_id, round_id);
        const inspected = await this.inspect(current, def, workflow_revision, resolver);
        if (!inspected.adoptable || current.input_hash !== round.input_hash) throw conflict(inspected.adoption_reason ?? "协调提议已变化，请重新协调");
        assert_agents(def);
      },
      record: async (session, run_id) => {
        if (workflow === undefined) throw conflict("采用缺少已核验流程");
        assert_agents(workflow);
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
        if (!(error instanceof SessionEventReadError || error instanceof ApiError)) throw error;
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
    this.closing_controller.abort();
    const active = [...this.active.values()];
    for (const round of active) round.controller.abort();
    await Promise.all(active.map((round) => round.promise));
    await Promise.allSettled([...this.answering.values()].map((answer) => answer.promise));
    await Promise.allSettled([...this.escalations.values()]);
    await Promise.allSettled([...this.retrying.values()].map(item => item.promise));
    await Promise.allSettled([...this.coordination_retrying.values()].map(item => item.promise));
  }
}
