/** ADR-0059：人工新预算的持久化来源链；只查授权前事实，后续撤回不自动取消 run。 */
import { AgentTaskStartedPayloadSchema, AgentTaskCompletedPayloadSchema, GoalAttemptCompletedPayloadSchema, GoalRetryAuthorizedPayloadSchema, CoordinatorRoundRequestedPayloadSchema, WorkflowRunStartedPayloadSchema,
  type EventEnvelope, type WorkflowDef } from "../core/schema.js";
import { SessionEventReadError } from "../core/session-events.js";
import { matchesWorkflowScope } from "../workflow/scope.js";
import { currentClarificationAnswers } from "./clarifications.js";

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function readGoalRetryAuthorization(events: readonly EventEnvelope[], run_id: string): EventEnvelope | null {
  const authorizations = events.filter(event => event.type === "goal.retry.authorized" && payload(event)["run_id"] === run_id);
  if (authorizations.length === 0) return null;
  if (authorizations.length !== 1) throw new SessionEventReadError("Goal 续跑授权不能重复");
  const event = authorizations[0]!;
  const parsed = GoalRetryAuthorizedPayloadSchema.safeParse(event.payload);
  if (!parsed.success || event.actor.kind !== "human" || event.correlation_id !== parsed.data.round_id) throw new SessionEventReadError("Goal 续跑缺少有效人工授权");
  const auth = parsed.data;
  const prefix = events.slice(0, events.findIndex(item => item.event_id === event.event_id));
  const scope = { workflow_id: auth.workflow_id, workflow_revision: auth.workflow_revision };
  const request = prefix.find(item => item.type === "coordinator.round.requested" && payload(item)["round_id"] === auth.round_id);
  const requested = CoordinatorRoundRequestedPayloadSchema.safeParse(request?.payload);
  const blocker = prefix.find(item => item.event_id === auth.goal_event_id);
  const blocked = GoalAttemptCompletedPayloadSchema.safeParse(blocker?.payload);
  const starts = prefix.filter(item => item.type === "workflow.run.started").map(item => ({ event: item, parsed: WorkflowRunStartedPayloadSchema.safeParse(item.payload) }));
  const current = starts.at(-1);
  const original = starts.find(item => item.parsed.success && item.parsed.data.run_id === auth.failed_run_id);
  const answer = currentClarificationAnswers(prefix, scope).find(item => item.event_id === auth.answer_event_id && item.round_id === auth.round_id && item.revoked_at === undefined);
  if (request === undefined || !requested.success || requested.data.trigger !== "goal_blocked" || requested.data.goal_event_id !== auth.goal_event_id
    || requested.data.run_id !== auth.failed_run_id || requested.data.node_id !== auth.node_id || !matchesWorkflowScope(requested.data, scope)
    || request.actor.kind !== "system" || request.actor.id !== "goal-supervisor" || request.correlation_id !== auth.round_id
    || blocker === undefined || blocker.type !== "goal.attempt.completed" || blocker.correlation_id !== auth.node_id || blocker.seq >= request.seq
    || blocker.actor.kind !== "system" || blocker.source.adapter !== "goal-runner" || !blocked.success || blocked.data.status !== "blocked"
    || blocked.data.run_id !== auth.failed_run_id || blocked.data.node_id !== auth.node_id || !matchesWorkflowScope(blocked.data, scope)
    || answer === undefined || current === undefined || !current.parsed.success || current.parsed.data.run_id !== run_id
    || current.parsed.data.goal_retry_round_id !== auth.round_id || !matchesWorkflowScope(current.parsed.data, scope)
    || current.event.actor.kind !== "human" || current.event.correlation_id !== run_id
    || prefix.some(item => ["agent.task.started", "goal.attempt.started"].includes(item.type) && payload(item)["run_id"] === run_id)
    || original === undefined || !original.parsed.success || original.event.seq >= blocker.seq
    || original.parsed.data.sdlc_id !== requested.data.sdlc_id || original.parsed.data.sdlc_version !== requested.data.sdlc_version
    || current.parsed.data.sdlc_id !== requested.data.sdlc_id || current.parsed.data.sdlc_version !== requested.data.sdlc_version
    || !matchesWorkflowScope(original.parsed.data, scope)) throw new SessionEventReadError("Goal 续跑授权与答复、阻塞或启动来源不一致");
  return event;
}

/** ADR-0062：旧授权仅能归因到首条合法 worker 事实，不跳过坏来源寻找后来成功。 */
export function readGoalRetryAgentIdentity(events: readonly EventEnvelope[], run_id: string, node: WorkflowDef["spec"]["nodes"][number]) {
  const authorization = readGoalRetryAuthorization(events, run_id);
  if (authorization === null) throw new SessionEventReadError("Goal 续跑授权缺失");
  const auth = GoalRetryAuthorizedPayloadSchema.parse(authorization.payload);
  if (node.id !== auth.node_id || node.run?.goal === undefined) throw new SessionEventReadError("Goal 续跑授权节点不匹配");
  const tasks = events.filter(event => ["agent.task.started", "agent.task.completed"].includes(event.type)
    && payload(event)["run_id"] === run_id && payload(event)["node_id"] === node.id);
  let configuration_hash = auth.agent_configuration_hash;
  for (const task of tasks) {
    const parsed = (task.type === "agent.task.started" ? AgentTaskStartedPayloadSchema : AgentTaskCompletedPayloadSchema).safeParse(task.payload);
    if (!parsed.success || task.seq <= authorization.seq || events.indexOf(task) <= events.indexOf(authorization)
      || task.session_id !== authorization.session_id || task.correlation_id !== node.id
      || task.actor.kind !== "agent" || task.actor.id !== "coordinator" || task.source.adapter !== "coordinator"
      || !matchesWorkflowScope(parsed.data, auth)
      || (task.type === "agent.task.completed" && parsed.data.driver !== node.run.agent)
      || parsed.data.agent_configuration_hash === undefined || !/^[0-9a-f]{64}$/.test(parsed.data.agent_configuration_hash)
      || events.filter(event => event.event_id === task.event_id).length !== 1) throw new SessionEventReadError("Goal 续跑 worker 配置来源不可验证");
    configuration_hash ??= parsed.data.agent_configuration_hash;
    if (configuration_hash !== parsed.data.agent_configuration_hash) throw new SessionEventReadError("Goal 续跑 worker 身份与人工授权不一致");
  }
  if (configuration_hash === undefined) throw new SessionEventReadError("旧 Goal 续跑授权没有可归因的 worker 配置身份");
  return { configuration_hash, worker_started: tasks.length > 0, node_input_hash: auth.node_input_hash };
}
