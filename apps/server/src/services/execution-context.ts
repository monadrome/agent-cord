/** ADR-0048：当前 run 的任务状态投影，不复制 runner 或注入日志。 */
import { AgentTaskStartedPayloadSchema, AgentTaskCompletedPayloadSchema, AgentTaskReusedPayloadSchema, CoordinationExecutionContextSchema, matchesWorkflowScope, readSessionEvents, resolveReusedCompletion,
  type CoordinationExecutionContext, type CoordinationTask, type EventEnvelope, type SessionHandle, type WorkflowDef } from "agent-cord";
import type { RunService } from "./run-service.js";

export async function readCoordinationExecutionContext(def: WorkflowDef, session: SessionHandle, workflow_revision: string | undefined, runs: RunService): Promise<CoordinationExecutionContext> {
  const nodes = def.spec.nodes.filter((node) => node.run !== undefined).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (nodes.length > 128) throw new Error("协调 worker 观察超过 128 项上限");
  const events = await readSessionEvents(session);
  const latest_run = await runs.latestRun(session.req_id, events);
  const run = latest_run?.workflow_revision === workflow_revision ? latest_run : null;
  const scope = { workflow_id: def.metadata.id, workflow_revision };
  const latest_tasks = new Map<string, EventEnvelope>();
  if (run !== null) for (const event of events) {
    if (!["agent.task.started", "agent.task.completed", "agent.task.reused"].includes(event.type) || !matchesWorkflowScope(event.payload, scope) || event.payload["run_id"] !== run.run_id) continue;
    const node_id = event.payload["node_id"];
    if (typeof node_id === "string" && nodes.some((node) => node.id === node_id)) latest_tasks.set(node_id, event);
  }
  const tasks: CoordinationTask[] = nodes.map((node) => {
    const observation: CoordinationTask = { node_id: node.id, run_id: run?.run_id ?? null, event_id: null, completion_event_id: null, status: "missing",
      attempt: null, max_attempts: null, failure_stage: null, retryable: null };
    const event = latest_tasks.get(node.id);
    if (event === undefined) return observation;
    observation.event_id = event.event_id;
    observation.status = "invalid";
    if (event.type === "agent.task.reused") {
      const original = resolveReusedCompletion(event, events);
      if (original === null) return observation;
      observation.status = "reused";
      observation.completion_event_id = AgentTaskReusedPayloadSchema.parse(event.payload).completion_event_id;
      return observation;
    }
    const parsed = event.type === "agent.task.started" ? AgentTaskStartedPayloadSchema.safeParse(event.payload) : AgentTaskCompletedPayloadSchema.safeParse(event.payload);
    if (!parsed.success || event.correlation_id !== node.id || (parsed.data.attempt !== undefined && parsed.data.max_attempts !== undefined && parsed.data.attempt > parsed.data.max_attempts)) return observation;
    observation.status = event.type === "agent.task.started" ? "started" : AgentTaskCompletedPayloadSchema.parse(event.payload).status;
    observation.attempt = parsed.data.attempt ?? null;
    observation.max_attempts = parsed.data.max_attempts ?? null;
    if (event.type === "agent.task.completed") {
      const value = AgentTaskCompletedPayloadSchema.parse(event.payload);
      if (value.status === "ok" && value.failure_stage !== undefined) return { ...observation, status: "invalid", attempt: null, max_attempts: null };
      observation.failure_stage = value.failure_stage ?? null;
      observation.retryable = value.retryable ?? null;
    }
    return observation;
  });
  return CoordinationExecutionContextSchema.parse({ run: run === null ? null : { run_id: run.run_id, status: run.status,
    active: ["running", "waiting_human"].includes(run.status) && runs.activeRunId(session.req_id) === run.run_id }, tasks });
}
