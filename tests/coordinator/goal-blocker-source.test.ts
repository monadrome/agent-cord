import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { GoalAttemptCompletedPayloadSchema, type EventEnvelope } from "../../src/core/schema.js";
import { resolveGoalBlocker, readGoalCoordinationRequest } from "../../src/coordinator/goal-coordination.js";

const binding = { session_id: "REQ-BLOCKER", workflow_id: "source-check", workflow_revision: "a".repeat(64), run_id: ulid(), node_id: "deliver", goal_event_id: ulid() };
function blocker(): EventEnvelope {
  return { event_id: binding.goal_event_id, session_id: binding.session_id, type: "goal.attempt.completed", schema_version: "1", seq: 1,
    prev_event_hash: null, timestamp: "2026-10-10T12:00:00.000Z", actor: { kind: "system", id: "goal-runner" }, source: { adapter: "goal-runner" }, correlation_id: binding.node_id,
    payload: GoalAttemptCompletedPayloadSchema.parse({ workflow_id: binding.workflow_id, workflow_revision: binding.workflow_revision, run_id: binding.run_id,
      node_id: binding.node_id, attempt: 1, status: "blocked", max_attempts: 1, failure_kind: "budget", reason: "自动尝试边界已达到" }) };
}
describe("指定Goal blocker来源", () => {
  it("有效宿主blocked返回结构化证据，不读取时钟或修改输入", () => {
    const event = blocker(); const before = structuredClone(event); expect(resolveGoalBlocker(event, binding)).toMatchObject({ status: "blocked", run_id: binding.run_id });
    expect(event).toEqual(before); expect(resolveGoalBlocker(undefined, binding)).toBeNull();
  });
  it.each(["event_id", "session", "type", "actor_kind", "actor_id", "adapter", "correlation", "workflow", "revision", "run", "node", "status", "payload"])("%s错误拒绝来源", mode => {
    const event = blocker();
    if (mode === "event_id") event.event_id = ulid();
    if (mode === "session") event.session_id = "REQ-OTHER";
    if (mode === "type") event.type = "goal.attempt.started";
    if (mode === "actor_kind") event.actor.kind = "agent";
    if (mode === "actor_id") event.actor.id = "foreign-system";
    if (mode === "adapter") event.source.adapter = "foreign";
    if (mode === "correlation") event.correlation_id = "other";
    if (mode === "workflow") event.payload["workflow_id"] = "other";
    if (mode === "revision") event.payload["workflow_revision"] = "b".repeat(64);
    if (mode === "run") event.payload["run_id"] = ulid();
    if (mode === "node") event.payload["node_id"] = "other";
    if (mode === "status") event.payload["status"] = "cancelled";
    if (mode === "payload") event.payload["attempt"] = -1;
    expect(resolveGoalBlocker(event, binding)).toBeNull();
  });
  it("历史请求不能从重复目标ID中选择第一条，即使第一条有效", () => {
    const event = blocker(); const round_id = ulid(); const requested: EventEnvelope = { ...event, event_id: ulid(), seq: 2, type: "coordinator.round.requested",
      actor: { kind: "system", id: "goal-supervisor" }, source: { adapter: "console-server" }, correlation_id: round_id,
      payload: { round_id, workflow_id: binding.workflow_id, workflow_revision: binding.workflow_revision, driver: "supervisor", trigger: "goal_blocked",
        run_id: binding.run_id, node_id: binding.node_id, goal_event_id: binding.goal_event_id, sdlc_id: "source-check", sdlc_version: 1 } };
    expect(readGoalCoordinationRequest([event, requested], round_id)).toBe(requested);
    expect(() => readGoalCoordinationRequest([event, requested, { ...event, seq: 3 }], round_id)).toThrow(/blocker 来源/);
  });
});
