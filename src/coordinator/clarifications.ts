/** ADR-0052：同批事实中的人工澄清，严格校验原问题与最后答复。 */
import { CoordinatorRoundAnsweredPayloadSchema, CoordinatorRoundCompletedPayloadSchema, type EventEnvelope, type WorkflowScope } from "../core/schema.js";
import { SessionEventReadError } from "../core/session-events.js";
import { matchesWorkflowScope } from "../workflow/scope.js";

export const MAX_CLARIFICATION_QUESTIONS = 128;
export interface SnapshotClarification { event_id: string; round_id: string; question: string; choice: string }
export interface ClarificationAnswer extends SnapshotClarification { answered_at: string; completion_event_id: string }
function as_record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export function readClarificationAnswers(events: readonly EventEnvelope[], scope?: WorkflowScope): ClarificationAnswer[] {
  const indexed = new Map(events.map((event, index) => [event.event_id, { event, index }]));
  const latest_completions = new Map<string, string>();
  for (const event of events) {
    const round_id = as_record(event.payload)?.["round_id"];
    if (event.type === "coordinator.round.completed" && typeof round_id === "string") latest_completions.set(round_id, event.event_id);
  }
  const answers: ClarificationAnswer[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "coordinator.round.answered") continue;
    const completion_id = as_record(event.payload)?.["completion_event_id"];
    const reference = typeof completion_id === "string" ? indexed.get(completion_id) : undefined;
    const correlated = event.correlation_id === null ? undefined : indexed.get(latest_completions.get(event.correlation_id) ?? "");
    if (scope !== undefined && !matchesWorkflowScope(event.payload, scope) && !matchesWorkflowScope(reference?.event.payload, scope) && !matchesWorkflowScope(correlated?.event.payload, scope)) continue;
    const parsed = CoordinatorRoundAnsweredPayloadSchema.safeParse(event.payload);
    if (!parsed.success || event.actor.kind !== "human" || event.correlation_id !== parsed.data.round_id || reference === undefined || reference.index >= index) {
      throw new SessionEventReadError("协调澄清事实不符合人工来源或因果引用契约");
    }
    const value = parsed.data;
    const original = reference.event;
    const completed = CoordinatorRoundCompletedPayloadSchema.safeParse(original.payload);
    if (original.type !== "coordinator.round.completed" || original.session_id !== event.session_id || original.correlation_id !== value.round_id || !completed.success
      || completed.data.status !== "ok" || completed.data.error !== null || completed.data.failure_stage !== undefined || completed.data.round_id !== value.round_id || completed.data.input_hash !== value.input_hash
      || !matchesWorkflowScope(completed.data, { workflow_id: value.workflow_id, workflow_revision: value.workflow_revision })
      || completed.data.proposal?.next_action.kind !== "ask_human" || latest_completions.get(value.round_id) !== original.event_id) {
      throw new SessionEventReadError("协调澄清不能引用缺失、失效或不匹配的问题完成");
    }
    const action = completed.data.proposal.next_action;
    if (new Set(action.options).size !== action.options.length || !action.options.includes(value.choice)) throw new SessionEventReadError("协调澄清选择不属于原问题选项");
    answers.push({ event_id: event.event_id, round_id: value.round_id, question: action.question, choice: value.choice,
      answered_at: event.timestamp, completion_event_id: original.event_id });
  }
  return answers;
}

export function projectClarifications(events: readonly EventEnvelope[], scope?: WorkflowScope): SnapshotClarification[] {
  const answers = readClarificationAnswers(events, scope);
  const latest = new Map<string, SnapshotClarification>();
  const by_id = new Map(events.map((event) => [event.event_id, event]));
  for (const { answered_at: _answered_at, completion_event_id, ...answer } of answers) {
    const source = by_id.get(completion_event_id)!;
    const source_payload = as_record(source.payload)!;
    const key = JSON.stringify([source_payload["workflow_id"], source_payload["workflow_revision"] ?? null, answer.question]);
    latest.delete(key); latest.set(key, answer);
  }
  if (latest.size > MAX_CLARIFICATION_QUESTIONS) throw new SessionEventReadError("当前澄清问题超过 128 项上限，不能静默丢弃人工材料");
  return [...latest.values()];
}
