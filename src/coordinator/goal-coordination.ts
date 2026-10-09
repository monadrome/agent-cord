/** ADR-0065：自动升级及人工重试的共用因果来源，不从失败跳过坏父轮次。 */
import { CoordinatorRoundRequestedPayloadSchema, CoordinatorRoundCompletedPayloadSchema, GoalAttemptCompletedPayloadSchema, type EventEnvelope } from "../core/schema.js";
import { SessionEventReadError } from "../core/session-events.js";
import { matchesWorkflowScope } from "../workflow/scope.js";

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function readGoalCoordinationRequest(events: readonly EventEnvelope[], round_id: string): EventEnvelope {
  const requests = events.filter(event => event.type === "coordinator.round.requested");
  const target = requests.filter(event => payload(event)["round_id"] === round_id);
  if (target.length !== 1) throw new SessionEventReadError("Goal 协调请求缺失或重复");
  const event = target[0]!;
  const prefix = events.slice(0, events.indexOf(event));
  const parsed = CoordinatorRoundRequestedPayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.trigger !== "goal_blocked" || event.correlation_id !== round_id || event.source.adapter !== "console-server"
    || events.filter(item => item.event_id === event.event_id).length !== 1) throw new SessionEventReadError("Goal 协调请求来源不可验证");
  const request = parsed.data;
  const blocker = prefix.find(item => item.event_id === request.goal_event_id);
  const goal = GoalAttemptCompletedPayloadSchema.safeParse(blocker?.payload);
  if (blocker === undefined || blocker.type !== "goal.attempt.completed" || blocker.session_id !== event.session_id || blocker.seq >= event.seq
    || blocker.actor.kind !== "system" || blocker.actor.id !== "goal-runner" || blocker.source.adapter !== "goal-runner" || blocker.correlation_id !== request.node_id
    || !goal.success || goal.data.status !== "blocked" || goal.data.run_id !== request.run_id || goal.data.node_id !== request.node_id || !matchesWorkflowScope(goal.data, request)) throw new SessionEventReadError("Goal 协调请求的 blocker 来源不可验证");
  if (request.retry_of_round_id === undefined) {
    if (event.actor.kind !== "system" || event.actor.id !== "goal-supervisor") throw new SessionEventReadError("自动 Goal 协调请求必须来自宿主");
    return event;
  }
  if (event.actor.kind !== "human") throw new SessionEventReadError("Goal 协调重试必须来自人工命令");
  const parent = readGoalCoordinationRequest(prefix, request.retry_of_round_id);
  const origin = CoordinatorRoundRequestedPayloadSchema.parse(parent.payload);
  const completed = prefix.filter(item => item.type === "coordinator.round.completed" && payload(item)["round_id"] === request.retry_of_round_id).at(-1);
  const result = CoordinatorRoundCompletedPayloadSchema.safeParse(completed?.payload);
  if (parent.session_id !== event.session_id || !matchesWorkflowScope(origin, request) || origin.run_id !== request.run_id || origin.node_id !== request.node_id
    || origin.goal_event_id !== request.goal_event_id || origin.driver !== request.driver || origin.sdlc_id !== request.sdlc_id || origin.sdlc_version !== request.sdlc_version
    || completed === undefined || completed.session_id !== event.session_id || completed.correlation_id !== origin.round_id || !result.success || !matchesWorkflowScope(result.data, request)
    || completed.seq >= event.seq || completed.seq <= parent.seq || prefix.indexOf(completed) <= prefix.indexOf(parent)
    || !((completed.actor.kind === "agent" && completed.actor.id === "context-session-agent" && completed.source.adapter === "context-session-agent")
      || (completed.actor.kind === "system" && completed.actor.id === "coordination-recovery" && completed.source.adapter === "console-server"))
    || !["failed", "timeout", "stale", "cancelled", "ok"].includes(result.data.status)
    || prefix.some(item => ["coordinator.round.answered", "goal.retry.authorized"].includes(item.type) && payload(item)["round_id"] === origin.round_id)
    || requests.filter(item => payload(item)["retry_of_round_id"] === origin.round_id).length !== 1) throw new SessionEventReadError("Goal 协调重试与父轮次来源不一致");
  for (const item of events) {
    if (!["coordinator.round.started", "coordinator.round.completed"].includes(item.type) || payload(item)["round_id"] !== request.round_id) continue;
    const hash = payload(item)["agent_configuration_hash"];
    if (hash !== undefined && hash !== request.retry_configuration_hash) throw new SessionEventReadError("Goal 协调重试派发身份与请求不一致");
  }
  return event;
}
