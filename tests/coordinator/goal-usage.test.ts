import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { type EventEnvelope } from "../../src/core/schema.js";
import { accumulateGoalUsage, goalUsageTotalsMatch, usageBudgetExceeded } from "../../src/coordinator/goal-usage.js";

const run_id = ulid();
const scope = { session_id: "REQ-USAGE", workflow_id: "usage", workflow_revision: "a".repeat(64), driver: "worker" };
function task(type: "agent.task.started" | "agent.task.completed", seq: number, usage?: unknown): EventEnvelope {
  return { event_id: ulid(), session_id: scope.session_id, seq, prev_event_hash: null, timestamp: "2026-10-09T00:00:00.000Z", schema_version: "1", type,
    actor: { kind: "agent", id: "coordinator" }, source: { adapter: "coordinator" }, correlation_id: "deliver",
    payload: { workflow_id: scope.workflow_id, workflow_revision: scope.workflow_revision, run_id, node_id: "deliver", driver: "worker", attempt: 1,
      execution_input_hash: "b".repeat(64), agent_configuration_hash: "c".repeat(64), ...(type === "agent.task.completed" ? { status: "ok", usage } : {}) } };
}
const read = (events: EventEnvelope[]) => accumulateGoalUsage(events, run_id, "deliver", scope);
const pair = (usage?: unknown) => [task("agent.task.started", 1), task("agent.task.completed", 2, usage)];

describe("Goal 严格计量来源", () => {
  it("逐指标完整性区分部分报告，未限 cost 的 token 预算仍有效", () => {
    const totals = read(pair({ input_tokens: 3, output_tokens: 2 }));
    expect(totals).toMatchObject({ input_tokens: 3, output_tokens: 2, cost_usd: null, unknown_input_tasks: 0, unknown_output_tasks: 0, unknown_cost_tasks: 1 });
    expect(usageBudgetExceeded({ max_input_tokens: 3 }, totals)).toBeNull();
    expect(usageBudgetExceeded({ max_cost_usd: 1 }, totals)).toBe("unknown_usage");
  });
  it("累计多次失败/成功，不扣除 cache，也不让后次报告补齐前次缺指标", () => {
    const events = [...pair({ input_tokens: 5, output_tokens: 0, cached_input_tokens: 5, cost_usd: 0.1 }), task("agent.task.started", 3), task("agent.task.completed", 4, { input_tokens: 6, output_tokens: 1 })];
    events[1]!.payload = { ...events[1]!.payload, status: "failed" };
    const totals = read(events);
    expect(totals).toMatchObject({ input_tokens: 11, output_tokens: 1, cost_usd: 0.1, observed_tasks: 2, unknown_cost_tasks: 1 });
    expect(usageBudgetExceeded({ max_input_tokens: 10 }, totals)).toBe("input_tokens");
    expect(usageBudgetExceeded({ max_output_tokens: 1 }, totals)).toBeNull();
    expect(usageBudgetExceeded({ max_cost_usd: 1 }, totals)).toBe("unknown_usage");
  });
  it.each([undefined, null, {}, { input_tokens: -1, output_tokens: 0.5, cost_usd: Infinity }, { input_tokens: "2", output_tokens: NaN, cost_usd: -1 }])("非法/未报告 usage %j 保留逐指标未知", usage => {
    const totals = read(pair(usage));
    expect(totals.unknown_input_tasks).toBe(1); expect(usageBudgetExceeded({ max_input_tokens: 10 }, totals)).toBe("unknown_usage");
    expect(usageBudgetExceeded(undefined, totals)).toBeNull();
  });
  it("合法零是真实计量，无 task 为尚未计量，悬空 started 为未知消耗", () => {
    expect(read(pair({ input_tokens: 0, output_tokens: 0, cost_usd: 0 }))).toMatchObject({ input_tokens: 0, cost_usd: 0, unknown_tasks: 0 });
    expect(usageBudgetExceeded({ max_input_tokens: 1 }, read([]))).toBeNull();
    expect(read([task("agent.task.started", 1)])).toMatchObject({ unknown_tasks: 1, unknown_input_tasks: 1, input_tokens: null });
    expect(usageBudgetExceeded({ max_cost_usd: 1 }, read([task("agent.task.started", 1)]))).toBe("unknown_usage");
  });
  it.each([
    { actor: { kind: "agent", id: "worker" } }, { source: { adapter: "foreign" } }, { session_id: "REQ-OTHER" }, { correlation_id: "other" }, { seq: 0 },
    { payload: { ...task("agent.task.completed", 2).payload, workflow_revision: "d".repeat(64) } },
    { payload: { ...task("agent.task.completed", 2).payload, execution_input_hash: "d".repeat(64) } },
    { payload: { ...task("agent.task.completed", 2).payload, agent_configuration_hash: "d".repeat(64) } },
    { payload: { ...task("agent.task.completed", 2).payload, agent_configuration_hash: undefined } },
  ])("完成来源 %j 拒绝", change => {
    const facts = pair({ input_tokens: 1 }); facts[1] = { ...facts[1]!, ...change } as EventEnvelope;
    expect(() => read(facts)).toThrow();
  });
  it("孤立/未来/重复完成不能少计或重复累计，其他 run 不混入", () => {
    const facts = pair({ input_tokens: 1, output_tokens: 2, cost_usd: 0.1 });
    expect(() => read([facts[1]!])).toThrow(); expect(() => read([facts[1]!, facts[0]!])).toThrow();
    expect(() => read([...facts, facts[1]!])).toThrow();
    expect(read([...facts, { ...facts[1]!, payload: { ...facts[1]!.payload, run_id: ulid() } }]).input_tokens).toBe(1);
  });
  it("相同缺省身份也不能证明成功调用；准备失败计量未知但无虚构消耗", () => {
    const facts = pair({ input_tokens: 1 });
    for (const event of facts) event.payload = { ...event.payload, agent_configuration_hash: undefined, execution_input_hash: undefined };
    expect(() => read(facts)).toThrow(/缺少输入或配置/);
    facts[1]!.payload = { ...facts[1]!.payload, status: "failed", failure_stage: "snapshot", usage: null };
    expect(read(facts).unknown_input_tasks).toBe(1);
  });
  it("cost 只容忍浮点相加误差，真正超限拒绝；旧汇总从来源重算", () => {
    const totals = read([...pair({ input_tokens: 1, output_tokens: 0, cost_usd: 0.1 }), task("agent.task.started", 3), task("agent.task.completed", 4, { input_tokens: 2, output_tokens: 0, cost_usd: 0.2 })]);
    expect(usageBudgetExceeded({ max_cost_usd: 0.3 }, totals)).toBeNull(); expect(usageBudgetExceeded({ max_cost_usd: 0.29 }, totals)).toBe("cost_usd");
    const { unknown_input_tasks, unknown_output_tasks, unknown_cost_tasks, ...legacy } = totals;
    expect(goalUsageTotalsMatch(legacy, totals)).toBe(true);
    expect(goalUsageTotalsMatch({ ...legacy, input_tokens: 0 }, totals)).toBe(false);
  });
});
