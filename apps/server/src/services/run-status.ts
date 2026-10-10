/** ADR-0076：只从当前活动 run 的同批事实派生等待，不改变操作登记或节点状态。 */
import { GateWaitingPayloadSchema, HumanDecisionRecordedPayloadSchema, WorkflowRunStartedPayloadSchema, matchesWorkflowScope, SessionEventReadError,
  type EventEnvelope } from "agent-cord";
import type { RunRow } from "./index-store.js";
import { scanPendingApprovals } from "./session-service.js";

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function project_active_run_wait(run: RunRow, events: readonly EventEnvelope[], active_run_id: string | null): RunRow {
  if (active_run_id !== run.run_id || (run.status !== "running" && run.status !== "waiting_human")) return run;
  const starts = events.filter(event => event.type === "workflow.run.started" && payload(event)["run_id"] === run.run_id);
  const parsed = WorkflowRunStartedPayloadSchema.safeParse(starts[0]?.payload);
  if (starts.length !== 1 || !parsed.success || starts[0]!.session_id !== run.req_id
    || parsed.data.workflow_revision !== run.workflow_revision || parsed.data.sdlc_id !== run.sdlc_id || parsed.data.sdlc_version !== run.sdlc_version
    || (parsed.data.coordination_round_id ?? null) !== (run.coordination_round_id ?? null) || (parsed.data.goal_retry_round_id ?? null) !== (run.goal_retry_round_id ?? null)) {
    throw new SessionEventReadError("活动 run 启动绑定不可验证，拒绝显示旧登记状态");
  }
  const scope = { workflow_id: parsed.data.workflow_id, workflow_revision: parsed.data.workflow_revision };
  const scoped_events = events.filter(event => event.type !== "workflow.run.cancelled" || payload(event)["run_id"] === run.run_id);
  const pending = scanPendingApprovals(scoped_events, scope);
  const needs_human = [...pending.values()].map(waiting => {
    const event = events.find(item => item.event_id === waiting.waiting_event_id)!;
    const checked = GateWaitingPayloadSchema.safeParse(event.payload);
    if (!checked.success || checked.data.evaluation_hash === undefined || checked.data.options === undefined) {
      throw new SessionEventReadError("活动 run 人工等待结构不可验证，拒绝显示旧登记状态");
    }
    return !events.some(decision => {
      if (decision.type !== "human.decision.recorded" || decision.actor.kind !== "human" || decision.seq <= event.seq || !matchesWorkflowScope(decision.payload, scope)) return false;
      const answer = HumanDecisionRecordedPayloadSchema.safeParse(decision.payload);
      return answer.success && answer.data.waiting_event_id === event.event_id && answer.data.evaluation_hash === checked.data.evaluation_hash
        && waiting.options.includes(answer.data.chosen) && answer.data.options[answer.data.chosen_index] === answer.data.chosen
        && JSON.stringify(answer.data.options) === JSON.stringify(waiting.options);
    });
  }).some(Boolean);
  return { ...run, status: needs_human ? "waiting_human" : "running" };
}
