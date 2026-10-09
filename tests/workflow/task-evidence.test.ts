/** 原完成引用必须符合 scope、节点、因果顺序和实际任务覆盖关系。 */
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { resolveReusedCompletion } from "../../src/workflow/task-evidence.js";
import type { EventEnvelope } from "../../src/core/schema.js";

const first_run = ulid(); const second_run = ulid();
const revision = "a".repeat(64);
function envelope(type: string, payload: Record<string, unknown>, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return { event_id: ulid(), session_id: "REQ-REUSE", type, schema_version: "1", seq: 1, prev_event_hash: null, timestamp: "2026-10-08T12:00:00.000Z",
    actor: { kind: "system", id: "test" }, correlation_id: "plan", source: { adapter: "test" },
    payload: { workflow_id: "reuse", workflow_revision: revision, node_id: "plan", ...payload }, ...overrides };
}
const completed = () => envelope("agent.task.completed", { run_id: first_run, driver: "worker", status: "ok", execution_input_hash: "b".repeat(64) });
const reused = (original: EventEnvelope, extra: Record<string, unknown> = {}) => envelope("agent.task.reused", {
  run_id: second_run, completion_event_id: original.event_id, execution_input_hash: "b".repeat(64), ...extra,
});

describe("复用来源校验", () => {
  it("有效的跨 run 原完成可解析，其他 scope/节点的任务不覆盖它", () => {
    const original = completed(); const reuse = reused(original);
    const other_scope = envelope("agent.task.started", { workflow_revision: "c".repeat(64), run_id: first_run, driver: "worker" });
    const other_node = envelope("agent.task.started", { node_id: "other", run_id: first_run, driver: "worker" }, { correlation_id: "other" });
    expect(resolveReusedCompletion(reuse, [original, other_scope, other_node, reuse])).toBe(original);
  });

  it.each([
    { status: "failed" }, { driver: undefined }, { workflow_revision: "c".repeat(64) }, { node_id: "other" },
    { run_id: second_run }, { status: "ok", failure_stage: "driver" },
    { attempt: 3, max_attempts: 2 },
  ])("非法原完成 payload %j 被拒绝", (value) => {
    const original = completed(); original.payload = { ...(original.payload as Record<string, unknown>), ...value };
    const reuse = reused(original);
    expect(resolveReusedCompletion(reuse, [original, reuse])).toBeNull();
  });

  it.each([{ type: "agent.task.started" }, { correlation_id: "other" }, { session_id: "REQ-FOREIGN" }])("非法原完成 envelope %j 被拒绝", (value) => {
    const original = { ...completed(), ...value }; const reuse = reused(original);
    expect(resolveReusedCompletion(reuse, [original, reuse])).toBeNull();
  });

  it("缺失、未来、自引用、错误 correlation 和摘要不一致都不可作为复用", () => {
    const original = completed(); const reuse = reused(original);
    expect(resolveReusedCompletion(reuse, [reuse])).toBeNull();
    expect(resolveReusedCompletion(reuse, [reuse, original])).toBeNull();
    expect(resolveReusedCompletion(reuse, [original])).toBeNull();
    const self = reused(original, { completion_event_id: reuse.event_id }); self.event_id = reuse.event_id;
    expect(resolveReusedCompletion(self, [original, self])).toBeNull();
    const wrong = { ...reuse, correlation_id: "other" };
    expect(resolveReusedCompletion(wrong, [original, wrong])).toBeNull();
    const mismatched = reused(original, { execution_input_hash: "c".repeat(64) });
    expect(resolveReusedCompletion(mismatched, [original, mismatched])).toBeNull();
  });

  it.each(["agent.task.started", "agent.task.completed"])("原完成被 %s 覆盖后不能重新指回旧成功", (type) => {
    const original = completed(); const next = envelope(type, { driver: "worker", status: "failed", run_id: first_run });
    const reuse = reused(original);
    expect(resolveReusedCompletion(reuse, [original, next, reuse])).toBeNull();
  });

  it("多 run 复用始终指回真实完成，不能把另一个复用当作原完成", () => {
    const original = completed(); const first_reuse = reused(original);
    const second_reuse = reused(original, { run_id: ulid() });
    expect(resolveReusedCompletion(second_reuse, [original, first_reuse, second_reuse])).toBe(original);
    const chained = reused(first_reuse, { run_id: ulid() });
    expect(resolveReusedCompletion(chained, [original, first_reuse, chained])).toBeNull();
  });
});
