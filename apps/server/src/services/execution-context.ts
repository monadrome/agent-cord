/** ADR-0048：当前 run 的任务状态投影，不复制 runner 或注入日志。 */
import { AgentTaskStartedPayloadSchema, AgentTaskCompletedPayloadSchema, AgentTaskReusedPayloadSchema, CoordinationExecutionContextSchema,
  GoalAttemptStartedPayloadSchema, GoalAttemptCompletedPayloadSchema, matchesWorkflowScope, readSessionEvents, resolveReusedCompletion,
  resolveGoalReadiness, readSessionDocument, sha256Hex, isVerificationRunCancelled, accumulateGoalUsage, usageBudgetExceeded, goalUsageTotalsMatch, canonicalJson,
  type CoordinationExecutionContext, type CoordinationGoal, type CoordinationTask, type EventEnvelope, type SessionHandle, type WorkflowDef } from "agent-cord";
import type { RunService } from "./run-service.js";
import type { GoalUsageView } from "../contracts.js";

export async function readCoordinationExecutionContext(def: WorkflowDef, session: SessionHandle, workflow_revision: string | undefined, runs: RunService): Promise<CoordinationExecutionContext> {
  const nodes = def.spec.nodes.filter((node) => node.run !== undefined).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (nodes.length > 128) throw new Error("协调 worker 观察超过 128 项上限");
  const events = await readSessionEvents(session);
  const latest_run = await runs.latestRun(session.req_id, events);
  const run = latest_run?.workflow_revision === workflow_revision ? latest_run : null;
  const scope = { workflow_id: def.metadata.id, workflow_revision };
  const latest_tasks = new Map<string, EventEnvelope>();
  const goal_nodes = def.spec.nodes.filter((node) => node.run?.goal !== undefined).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (goal_nodes.length > 128) throw new Error("协调 Goal 观察超过 128 项上限");
  const latest_goals = new Map<string, EventEnvelope>();
  if (run !== null) for (const event of events) {
    if (!["agent.task.started", "agent.task.completed", "agent.task.reused"].includes(event.type) || !matchesWorkflowScope(event.payload, scope) || event.payload["run_id"] !== run.run_id) continue;
    const node_id = event.payload["node_id"];
    if (typeof node_id === "string" && nodes.some((node) => node.id === node_id)) latest_tasks.set(node_id, event);
  }
  if (run !== null) for (const event of events) {
    if (!["goal.attempt.started", "goal.attempt.completed"].includes(event.type) || !matchesWorkflowScope(event.payload, scope) || event.payload["run_id"] !== run.run_id) continue;
    const node_id = event.payload["node_id"];
    if (typeof node_id === "string" && goal_nodes.some((node) => node.id === node_id)) latest_goals.set(node_id, event);
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
  const goals: CoordinationGoal[] = await Promise.all(goal_nodes.map(async (node) => {
    const observation: CoordinationGoal = { node_id: node.id, run_id: run?.run_id ?? null, event_id: null, status: "missing",
      current: null, freshness_reason: "not_ready",
      attempt: null, max_attempts: null, failure_kind: null, reason: null, input_hash: null, source_hash: null, artifact_hash: null, verification_event_ids: [] };
    const event = latest_goals.get(node.id);
    if (node.run!.goal!.usage_budget !== undefined) {
      observation.usage_budget = node.run!.goal!.usage_budget;
      try {
        observation.usage_totals = accumulateGoalUsage(events, run?.run_id ?? "", node.id, { ...scope, session_id: session.req_id, driver: node.run!.agent });
      } catch {
        if (event !== undefined) observation.event_id = event.event_id;
        if (event === undefined) throw new Error("Goal 计量来源存在而 Goal 启动事实缺失");
        return { ...observation, status: "invalid", current: false, freshness_reason: "invalid_evidence" };
      }
    }
    if (event === undefined) return observation;
    observation.event_id = event.event_id;
    observation.status = "invalid";
    observation.current = false; observation.freshness_reason = "invalid_evidence";
    if (event.actor.kind !== "system" || event.actor.id !== "goal-runner" || event.source.adapter !== "goal-runner") return observation;
    if (event.type === "goal.attempt.started") {
      const parsed = GoalAttemptStartedPayloadSchema.safeParse(event.payload);
      if (!parsed.success || event.correlation_id !== node.id || parsed.data.attempt > node.run!.goal!.max_attempts) return observation;
      observation.status = "started";
      observation.current = null; observation.freshness_reason = "not_ready";
      observation.attempt = parsed.data.attempt;
      observation.max_attempts = node.run?.goal?.max_attempts ?? null;
      return observation;
    }
    const parsed = GoalAttemptCompletedPayloadSchema.safeParse(event.payload);
    if (!parsed.success || event.correlation_id !== node.id || parsed.data.attempt > node.run!.goal!.max_attempts
      || (parsed.data.max_attempts !== undefined && parsed.data.max_attempts !== node.run!.goal!.max_attempts)) return observation;
    observation.status = parsed.data.status;
    observation.attempt = parsed.data.attempt ?? null;
    observation.max_attempts = parsed.data.max_attempts ?? null;
    observation.failure_kind = parsed.data.failure_kind ?? null;
    observation.reason = parsed.data.reason;
    observation.input_hash = parsed.data.input_hash ?? null;
    observation.source_hash = parsed.data.source_hash ?? null;
    observation.artifact_hash = parsed.data.artifact_hash ?? null;
    observation.verification_event_ids = parsed.data.verification_event_ids;
    if ((parsed.data.usage_budget !== undefined && canonicalJson(parsed.data.usage_budget) !== canonicalJson(observation.usage_budget))
      || (parsed.data.usage_totals !== undefined && (observation.usage_totals === undefined || !goalUsageTotalsMatch(parsed.data.usage_totals, observation.usage_totals)))) {
      return { ...observation, status: "invalid", current: false, freshness_reason: "invalid_evidence" };
    }
    observation.current = null; observation.freshness_reason = "not_ready";
    if (parsed.data.status === "ready" && run !== null) {
      if (isVerificationRunCancelled(events, { ...scope, run_id: run.run_id })) {
        observation.current = false; observation.freshness_reason = "run_cancelled";
        return observation;
      }
      const proof = resolveGoalReadiness(event, events, node, { ...scope, run_id: run.run_id });
      if (proof === null) return { ...observation, status: "invalid", current: false, freshness_reason: "invalid_evidence" };
      if (parsed.data.acceptance_evidence !== undefined) observation.acceptance_evidence = parsed.data.acceptance_evidence;
      try {
        const config = runs.configurationHashFor(session.req_id, node.run!.agent);
        const before = await runs.readNodeInput(def, node, session, config, workflow_revision);
        const guide = await readSessionDocument(session.dir, node.artifact!);
        const after = await runs.readNodeInput(def, node, session, config, workflow_revision);
        observation.current = before.input_hash === proof.input_hash && before.source_hash === proof.source_hash
          && after.input_hash === before.input_hash && after.source_hash === before.source_hash && guide !== null && sha256Hex(guide) === proof.artifact_hash;
        observation.freshness_reason = observation.current ? "current" : "stale_input";
      } catch { observation.current = null; observation.freshness_reason = "unavailable"; }
    }
    return observation;
  }));
  return CoordinationExecutionContextSchema.parse({ run: run === null ? null : { run_id: run.run_id, status: run.status,
    active: ["running", "waiting_human"].includes(run.status) && runs.activeRunId(session.req_id) === run.run_id }, tasks, goals });
}

/** 当前资源来自同一执行观察；历史协调轮次不把旧 run 计量当当前额度。 */
export function goalUsageViews(context: CoordinationExecutionContext): GoalUsageView[] {
  return context.goals.flatMap(goal => {
    if (goal.usage_budget === undefined) return [];
    const totals = goal.usage_totals ?? null;
    const limit = totals === null ? null : usageBudgetExceeded(goal.usage_budget, totals);
    const status: GoalUsageView["status"] = goal.status === "invalid" ? "invalid" : limit === "unknown_usage" ? "unknown"
      : limit !== null ? "exceeded" : totals === null || (totals.observed_tasks === 0 && totals.unknown_tasks === 0) ? "not_started" : "observed";
    return [{ run_id: goal.run_id, event_id: goal.event_id, node_id: goal.node_id, status, usage_budget: goal.usage_budget, usage_totals: totals,
      reason: status === "invalid" ? "资源或 Goal 来源不可核验" : status === "unknown" ? context.run?.active === true
        ? "当前任务尚未完整报告受限指标，等待计量结果" : "受限指标存在未知计量，停止自动执行"
        : status === "exceeded" ? "已观测消耗超过声明上限" : null }];
  });
}
