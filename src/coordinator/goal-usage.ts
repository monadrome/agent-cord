/** ADR-0067：配对合法任务来源，保留各指标可观测下界与未知次数。 */
import { AgentTaskStartedPayloadSchema, AgentTaskCompletedPayloadSchema, GoalUsageBudgetSchema, GoalUsageTotalsSchema,
  type EventEnvelope, type GoalUsageBudget, type GoalUsageTotals, type WorkflowScope } from "../core/schema.js";
import { canonicalJson } from "../core/hash.js";
import { SessionEventReadError } from "../core/session-events.js";
import { matchesWorkflowScope } from "../workflow/scope.js";

export type GoalUsageScope = WorkflowScope & { session_id: string; driver: string };
function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function accumulateGoalUsage(events: readonly EventEnvelope[], run_id: string, node_id: string, scope: GoalUsageScope): GoalUsageTotals {
  const sums = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const unknown = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const seen = { input_tokens: false, output_tokens: false, cost_usd: false };
  let observed_tasks = 0; let unknown_tasks = 0;
  let pending: EventEnvelope | null = null;
  const count = (usage: Record<string, unknown>) => {
    let observed = false;
    for (const key of ["input_tokens", "output_tokens", "cost_usd"] as const) {
      const value = usage[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "cost_usd" && !Number.isSafeInteger(value))) {
        unknown[key]++;
      } else {
        sums[key] += value; seen[key] = true; observed = true;
        if (!Number.isFinite(sums[key]) || (key !== "cost_usd" && !Number.isSafeInteger(sums[key]))) throw new SessionEventReadError("Goal 计量累计超出可表示范围");
      }
    }
    if (observed) observed_tasks++; else unknown_tasks++;
  };
  const ids = new Set<string>();
  for (const event of events) {
    const data = payload(event);
    if (!["agent.task.started", "agent.task.completed"].includes(event.type) || data["run_id"] !== run_id || data["node_id"] !== node_id) continue;
    if (event.session_id !== scope.session_id || !matchesWorkflowScope(data, scope) || event.correlation_id !== node_id
      || event.actor.kind !== "agent" || event.actor.id !== "coordinator" || event.source.adapter !== "coordinator"
      || ids.has(event.event_id)) throw new SessionEventReadError("Goal 计量任务来源不可验证");
    ids.add(event.event_id);
    if (event.type === "agent.task.started") {
      if (!AgentTaskStartedPayloadSchema.safeParse(data).success) throw new SessionEventReadError("Goal 计量启动事实不符合契约");
      if (pending !== null) count({});
      pending = event;
    } else {
      const completion = AgentTaskCompletedPayloadSchema.safeParse({ ...data, usage: null });
      if (!completion.success || pending === null || event.seq <= pending.seq || completion.data.driver !== scope.driver
        || data["execution_input_hash"] !== payload(pending)["execution_input_hash"]
        || data["agent_configuration_hash"] !== payload(pending)["agent_configuration_hash"]
        || data["attempt"] !== payload(pending)["attempt"]) throw new SessionEventReadError("Goal 计量完成事实与启动来源不一致");
      if ((completion.data.status === "ok" || completion.data.failure_stage === "driver")
        && (![data["execution_input_hash"], data["agent_configuration_hash"]].every(hash => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))) {
        throw new SessionEventReadError("Goal 计量调用缺少输入或配置身份");
      }
      const usage = data["usage"];
      count(typeof usage === "object" && usage !== null && !Array.isArray(usage) ? usage as Record<string, unknown> : {});
      pending = null;
    }
  }
  if (pending !== null) count({});
  return GoalUsageTotalsSchema.parse({ input_tokens: seen.input_tokens ? sums.input_tokens : null, output_tokens: seen.output_tokens ? sums.output_tokens : null,
    cost_usd: seen.cost_usd ? sums.cost_usd : null, observed_tasks, unknown_tasks,
    unknown_input_tasks: unknown.input_tokens, unknown_output_tasks: unknown.output_tokens, unknown_cost_tasks: unknown.cost_usd });
}

export function usageBudgetExceeded(budget: GoalUsageBudget | undefined, totals: GoalUsageTotals): "input_tokens" | "output_tokens" | "cost_usd" | "unknown_usage" | null {
  if (budget === undefined) return null;
  const parsed = GoalUsageBudgetSchema.parse(budget);
  if ((parsed.max_input_tokens !== undefined && ((totals.unknown_input_tasks ?? totals.unknown_tasks) > 0 || (totals.observed_tasks > 0 && totals.input_tokens === null)))
    || (parsed.max_output_tokens !== undefined && ((totals.unknown_output_tasks ?? totals.unknown_tasks) > 0 || (totals.observed_tasks > 0 && totals.output_tokens === null)))
    || (parsed.max_cost_usd !== undefined && ((totals.unknown_cost_tasks ?? totals.unknown_tasks) > 0 || (totals.observed_tasks > 0 && totals.cost_usd === null)))) return "unknown_usage";
  if (parsed.max_input_tokens !== undefined && totals.input_tokens !== null && totals.input_tokens > parsed.max_input_tokens) return "input_tokens";
  if (parsed.max_output_tokens !== undefined && totals.output_tokens !== null && totals.output_tokens > parsed.max_output_tokens) return "output_tokens";
  // 厂商 cost 是浮点数；只容忍相加产生的机器精度误差。
  if (parsed.max_cost_usd !== undefined && totals.cost_usd !== null && totals.cost_usd - parsed.max_cost_usd > Number.EPSILON * Math.max(Number.MIN_VALUE, totals.cost_usd, parsed.max_cost_usd)) return "cost_usd";
  return null;
}

export function goalUsageTotalsMatch(claimed: GoalUsageTotals, actual: GoalUsageTotals): boolean {
  const normalized = { ...actual };
  for (const key of ["unknown_input_tasks", "unknown_output_tasks", "unknown_cost_tasks"] as const) if (claimed[key] === undefined) delete normalized[key];
  return canonicalJson(claimed) === canonicalJson(normalized);
}
