/** ADR-0066：从 task.completed 事实累计可观察 usage，不把未知伪造为零。 */
import { AgentTaskCompletedPayloadSchema, GoalUsageBudgetSchema, GoalUsageTotalsSchema, type EventEnvelope, type GoalUsageBudget, type GoalUsageTotals } from "../core/schema.js";

function payload(event: EventEnvelope): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

export function accumulateGoalUsage(events: readonly EventEnvelope[], run_id: string, node_id: string): GoalUsageTotals {
  let input_tokens = 0; let output_tokens = 0; let cost_usd = 0; let input_seen = false; let output_seen = false; let cost_seen = false;
  let observed_tasks = 0; let unknown_tasks = 0;
  for (const event of events) {
    if (event.type !== "agent.task.completed" || payload(event)["run_id"] !== run_id || payload(event)["node_id"] !== node_id) continue;
    const parsed = AgentTaskCompletedPayloadSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.usage === null || parsed.data.usage === undefined) { unknown_tasks++; continue; }
    const usage = parsed.data.usage; let observed = false;
    if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0) { input_tokens += usage.input_tokens; input_seen = true; observed = true; }
    if (typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0) { output_tokens += usage.output_tokens; output_seen = true; observed = true; }
    if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) { cost_usd += usage.cost_usd; cost_seen = true; observed = true; }
    if (observed) observed_tasks++; else unknown_tasks++;
  }
  return GoalUsageTotalsSchema.parse({ input_tokens: input_seen ? input_tokens : null, output_tokens: output_seen ? output_tokens : null,
    cost_usd: cost_seen ? cost_usd : null, observed_tasks, unknown_tasks });
}

export function usageBudgetExceeded(budget: GoalUsageBudget | undefined, totals: GoalUsageTotals): "input_tokens" | "output_tokens" | "cost_usd" | null {
  if (budget === undefined) return null;
  const parsed = GoalUsageBudgetSchema.parse(budget);
  if (parsed.max_input_tokens !== undefined && totals.input_tokens !== null && totals.input_tokens > parsed.max_input_tokens) return "input_tokens";
  if (parsed.max_output_tokens !== undefined && totals.output_tokens !== null && totals.output_tokens > parsed.max_output_tokens) return "output_tokens";
  if (parsed.max_cost_usd !== undefined && totals.cost_usd !== null && totals.cost_usd > parsed.max_cost_usd) return "cost_usd";
  return null;
}
