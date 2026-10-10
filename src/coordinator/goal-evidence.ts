/** ADR-0061：runner 与协调共用 Goal ready 来源，不回退已被替换的成功。 */
import { AgentTaskCompletedPayloadSchema, GoalAttemptStartedPayloadSchema, GoalAttemptCompletedPayloadSchema, VerificationCompletedPayloadSchema,
  type EventEnvelope, type WorkflowDef, type WorkflowScope } from "../core/schema.js";
import { matchesWorkflowScope } from "../workflow/scope.js";
import { isVerificationRunCancelled } from "../workflow/verification.js";
import { goalCommandHash } from "../workflow/host-verification.js";
import { goalAcceptanceIsComplete } from "./goal-acceptance.js";
import { accumulateGoalUsage, goalUsageTotalsMatch, usageBudgetExceeded } from "./goal-usage.js";
import { canonicalJson } from "../core/hash.js";

export interface GoalReadinessEvidence {
  completion: EventEnvelope;
  input_hash: string;
  source_hash: string;
  artifact_hash: string;
}

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function resolveGoalReadiness(candidate: EventEnvelope, events: readonly EventEnvelope[], node: WorkflowDef["spec"]["nodes"][number], scope: WorkflowScope & { run_id: string }): GoalReadinessEvidence | null {
  const goal = node.run?.goal;
  const index = events.findIndex(event => event.event_id === candidate.event_id);
  const event = events[index];
  if (goal === undefined || node.artifact === undefined || index < 0 || event?.type !== "goal.attempt.completed"
    || events.filter(item => item.event_id === candidate.event_id).length !== 1
    || event.actor.kind !== "system" || event.actor.id !== "goal-runner" || event.source.adapter !== "goal-runner" || event.correlation_id !== node.id) return null;
  const parsed = GoalAttemptCompletedPayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.status !== "ready" || !matchesWorkflowScope(parsed.data, scope) || parsed.data.run_id !== scope.run_id
    || parsed.data.node_id !== node.id || parsed.data.attempt > goal.max_attempts
    || (parsed.data.max_attempts !== undefined && (parsed.data.max_attempts !== goal.max_attempts || parsed.data.attempt > parsed.data.max_attempts))) return null;
  const ready = parsed.data;
  if (!goalAcceptanceIsComplete(goal, ready.acceptance_evidence, ready.verification_event_ids)) return null;
  if (goal.usage_budget !== undefined) {
    if (ready.usage_budget === undefined || ready.usage_totals === undefined || canonicalJson(ready.usage_budget) !== canonicalJson(goal.usage_budget)) return null;
    try {
      const actual = accumulateGoalUsage(events.slice(0, index), scope.run_id, node.id, { ...scope, session_id: event.session_id, driver: node.run!.agent });
      if (!goalUsageTotalsMatch(ready.usage_totals, actual) || usageBudgetExceeded(goal.usage_budget, actual) !== null) return null;
    } catch { return null; }
  }
  if (ready.input_hash === undefined || ready.source_hash === undefined || ready.artifact_hash === undefined || ready.completion_event_id === undefined
    || goal.checks.length !== ready.verification_event_ids.length || new Set(ready.verification_event_ids).size !== ready.verification_event_ids.length) return null;
  const belongs = (item: EventEnvelope) => item.session_id === event.session_id && matchesWorkflowScope(item.payload, scope)
    && payload(item)["run_id"] === scope.run_id && payload(item)["node_id"] === node.id;
  if (events.filter(item => ["goal.attempt.started", "goal.attempt.completed"].includes(item.type) && belongs(item)).at(-1)?.event_id !== event.event_id
    || isVerificationRunCancelled(events, scope)) return null;
  const completion = events.filter(item => ["agent.task.started", "agent.task.completed", "agent.task.reused"].includes(item.type) && belongs(item)).at(-1);
  const task_index = events.findIndex(item => item.event_id === ready.completion_event_id);
  const started = events.filter(item => item.type === "goal.attempt.started" && belongs(item)).at(-1);
  const started_index = events.findIndex(item => item.event_id === started?.event_id);
  const attempt = GoalAttemptStartedPayloadSchema.safeParse(started?.payload);
  if (started === undefined || started_index < 0 || started_index >= task_index || started.correlation_id !== node.id
    || started.actor.kind !== "system" || started.actor.id !== "goal-runner" || started.source.adapter !== "goal-runner"
    || !attempt.success || attempt.data.attempt !== ready.attempt) return null;
  const task = AgentTaskCompletedPayloadSchema.safeParse(completion?.payload);
  if (completion?.event_id !== ready.completion_event_id || completion.type !== "agent.task.completed" || task_index < 0 || task_index >= index
    || events.filter(item => item.event_id === ready.completion_event_id).length !== 1
    || completion.correlation_id !== node.id || completion.actor.kind !== "agent" || completion.actor.id !== "coordinator" || completion.source.adapter !== "coordinator"
    || !task.success || task.data.status !== "ok" || task.data.failure_stage !== undefined
    || (task.data.attempt !== undefined && task.data.max_attempts !== undefined && task.data.attempt > task.data.max_attempts)
    || task.data.artifact !== node.artifact || task.data.artifact_written !== true || task.data.artifact_after_hash == null
    || !/^[0-9a-f]{64}$/.test(task.data.artifact_after_hash)
    || !["agent", "coordinator"].includes(task.data.written_by ?? "")) return null;
  for (const [check_index, command] of goal.checks.entries()) {
    const result = events.filter(item => item.type === "verification.completed" && belongs(item) && payload(item)["verification_id"] === command.id).at(-1);
    const result_index = events.findIndex(item => item.event_id === result?.event_id);
    const value = VerificationCompletedPayloadSchema.safeParse(result?.payload);
    if (result === undefined || result.event_id !== ready.verification_event_ids[check_index] || result_index <= task_index || result_index >= index
      || events.filter(item => item.event_id === result.event_id).length !== 1
      || result.correlation_id !== node.id || result.actor.kind !== "system" || result.actor.id !== "goal-runner" || result.source.adapter !== "goal-runner"
      || !value.success || value.data.status !== "passed" || value.data.exit_code !== 0 || value.data.input_hash !== ready.input_hash
      || value.data.source_hash !== ready.source_hash || value.data.command_hash !== goalCommandHash(command)) return null;
  }
  return { completion, input_hash: ready.input_hash, source_hash: ready.source_hash, artifact_hash: ready.artifact_hash };
}
