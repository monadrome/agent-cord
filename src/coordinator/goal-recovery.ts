/** ADR-0063：恢复意图只引用原授权与当时 checkpoint，不改预算。 */
import { GoalRecoveryRequestedPayloadSchema, GoalRetryAuthorizedPayloadSchema, type EventEnvelope } from "../core/schema.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { SessionEventReadError } from "../core/session-events.js";
import { matchesWorkflowScope } from "../workflow/scope.js";
import { readGoalRetryAuthorization } from "./goal-retry.js";

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

type Request = ReturnType<typeof GoalRecoveryRequestedPayloadSchema.parse>;

export function goalRecoveryInputHash(input: Omit<Request, "input_hash">): string {
  return sha256Hex(canonicalJson({ domain: "cord.goal-recovery-input.v1", ...input }));
}

export function goalRecoveryCheckpoint(events: readonly EventEnvelope[], scope: { workflow_id: string; workflow_revision: string; run_id: string; node_id: string }): EventEnvelope | null {
  return events.filter(event => ["agent.task.started", "agent.task.completed", "goal.attempt.started", "goal.attempt.completed"].includes(event.type)
    && matchesWorkflowScope(event.payload, scope) && payload(event)["run_id"] === scope.run_id && payload(event)["node_id"] === scope.node_id).at(-1) ?? null;
}

export function readGoalRecoveryRequest(events: readonly EventEnvelope[], run_id: string): { event: EventEnvelope; request: Request; consumed: boolean } | null {
  const requests = events.filter(event => event.type === "goal.recovery.requested" && payload(event)["run_id"] === run_id);
  if (requests.length === 0) return null;
  const authorization = readGoalRetryAuthorization(events, run_id);
  if (authorization === null) throw new SessionEventReadError("Goal 恢复缺少原授权");
  const auth = GoalRetryAuthorizedPayloadSchema.parse(authorization.payload);
  let prior: EventEnvelope | null = null;
  for (const event of requests) {
    const parsed = GoalRecoveryRequestedPayloadSchema.safeParse(event.payload);
    const prefix = events.slice(0, events.indexOf(event));
    if (!parsed.success || event.actor.kind !== "human" || event.source.adapter !== "console-server" || event.correlation_id !== run_id
      || event.session_id !== authorization.session_id || event.seq <= authorization.seq || !prefix.includes(authorization)
      || events.filter(item => item.event_id === event.event_id).length !== 1) throw new SessionEventReadError("Goal 恢复请求来源不可验证");
    const request = parsed.data;
    const { input_hash, ...input } = request;
    if (!matchesWorkflowScope(request, auth) || request.node_id !== auth.node_id || request.authorization_event_id !== authorization.event_id
      || request.prior_request_event_id !== (prior?.event_id ?? null)
      || request.checkpoint_event_id !== (goalRecoveryCheckpoint(prefix, request)?.event_id ?? null)
      || input_hash !== goalRecoveryInputHash(input)
      || (auth.agent_configuration_hash !== undefined && request.agent_configuration_hash !== auth.agent_configuration_hash)) throw new SessionEventReadError("Goal 恢复请求与原授权或 checkpoint 不一致");
    prior = event;
  }
  const event = prior!; const request = GoalRecoveryRequestedPayloadSchema.parse(event.payload);
  const consumed = events.slice(events.indexOf(event) + 1).some(item => ["agent.task.started", "agent.task.completed", "goal.attempt.started", "goal.attempt.completed", "gate.waiting", "gate.invalidated", "human.decision.recorded", "workflow.node.exited"].includes(item.type)
    && matchesWorkflowScope(item.payload, request) && (payload(item)["node_id"] === request.node_id || item.correlation_id === request.node_id)
    && (["gate.waiting", "gate.invalidated", "human.decision.recorded", "workflow.node.exited"].includes(item.type) || payload(item)["run_id"] === run_id));
  return { event, request, consumed };
}
