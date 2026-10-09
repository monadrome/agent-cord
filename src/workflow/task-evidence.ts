/** ADR-0049：复用引用必须指向同节点有效且未被新任务覆盖的原完成事实。 */
import { AgentTaskCompletedPayloadSchema, AgentTaskReusedPayloadSchema, type EventEnvelope } from "../core/schema.js";
import { matchesWorkflowScope } from "./scope.js";

export function resolveReusedCompletion(event: EventEnvelope, events: readonly EventEnvelope[]): EventEnvelope | null {
  if (event.type !== "agent.task.reused") return null;
  const parsed = AgentTaskReusedPayloadSchema.safeParse(event.payload);
  if (!parsed.success || event.correlation_id !== parsed.data.node_id) return null;
  const reuse = parsed.data;
  const scope = { workflow_id: reuse.workflow_id, workflow_revision: reuse.workflow_revision };
  const index = events.findIndex((item) => item.event_id === event.event_id);
  const original_index = events.findIndex((item) => item.event_id === reuse.completion_event_id);
  if (original_index < 0 || original_index >= index) return null;
  const original = events[original_index]!;
  const completed = AgentTaskCompletedPayloadSchema.safeParse(original.payload);
  if (original.type !== "agent.task.completed" || original.session_id !== event.session_id || original.correlation_id !== reuse.node_id || !completed.success
    || completed.data.status !== "ok" || completed.data.failure_stage !== undefined || completed.data.node_id !== reuse.node_id
    || (completed.data.attempt !== undefined && completed.data.max_attempts !== undefined && completed.data.attempt > completed.data.max_attempts)
    || completed.data.run_id === reuse.run_id || !matchesWorkflowScope(completed.data, scope)) return null;
  for (const key of ["execution_input_hash", "agent_configuration_hash", "source_hash", "artifact_after_hash"] as const) {
    if (reuse[key] !== undefined && reuse[key] !== completed.data[key]) return null;
  }
  if (events.slice(original_index + 1, index).some((item) => ["agent.task.started", "agent.task.completed"].includes(item.type)
    && matchesWorkflowScope(item.payload, scope) && item.payload["node_id"] === reuse.node_id)) return null;
  return original;
}
