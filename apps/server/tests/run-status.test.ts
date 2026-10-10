import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { EventEnvelope } from "agent-cord";
import type { RunRow } from "../src/services/index-store.js";
import { project_active_run_wait } from "../src/services/run-status.js";

const revision = "a".repeat(64); const run_id = ulid();
const row: RunRow = { run_id, req_id: "REQ-STATUS", sdlc_id: "status", sdlc_version: 1, workflow_revision: revision,
  status: "running", started_at: "2026-10-10T12:00:00.000Z", finished_at: null, error: null };
function event(type: string, payload: Record<string, unknown>, seq: number, actor: "human" | "system" = "system"): EventEnvelope {
  return { event_id: ulid(), session_id: row.req_id, seq, prev_event_hash: null, timestamp: row.started_at, type, schema_version: "1",
    actor: { kind: actor, id: "test" }, correlation_id: null, payload: { workflow_id: "status-workflow", workflow_revision: revision, ...payload }, source: { adapter: "test" } };
}
const started = () => event("workflow.run.started", { run_id, sdlc_id: "status", sdlc_version: 1 }, 1);
const waiting = (extra: Record<string, unknown> = {}) => event("gate.waiting", { node_id: "review", gate_id: "human", options: ["确认放行", "拒绝放行"],
  evaluation_hash: "b".repeat(64), kind: "human_confirm", ...extra }, 2);
function decision(wait: EventEnvelope, patch: Record<string, unknown> = {}) {
  return event("human.decision.recorded", { waiting_event_id: wait.event_id, evaluation_hash: wait.payload["evaluation_hash"], question: "review",
    options: ["确认放行", "拒绝放行"], chosen: "确认放行", chosen_index: 0, timeout_ms: null, default_index: 0, fallback: null, raw_input: null, ...patch }, 3, "human");
}

describe("活动 run 人工等待事实投影", () => {
  it("gate waiting 已落盘即显示等待，不需要 ask 或索引完成登记", () => {
    const original = structuredClone(row);
    expect(project_active_run_wait(row, [started(), waiting()], run_id)).toMatchObject({ status: "waiting_human", finished_at: null });
    expect(row).toEqual(original);
  });
  it("有效放行或拒绝选择说明输入已给出，显示继续处理而不声称 gate 通过", () => {
    const wait = waiting();
    for (const patch of [{}, { chosen: "拒绝放行", chosen_index: 1 }]) {
      expect(project_active_run_wait({ ...row, status: "waiting_human" }, [started(), wait, decision(wait, patch)], run_id).status).toBe("running");
    }
  });
  it.each(["foreign_wait", "wrong_hash", "wrong_revision", "wrong_options", "wrong_index", "not_human", "before_wait"])("%s 决定不移除当前等待", mode => {
    const wait = waiting(); const answer = decision(wait);
    if (mode === "foreign_wait") answer.payload["waiting_event_id"] = ulid();
    if (mode === "wrong_hash") answer.payload["evaluation_hash"] = "c".repeat(64);
    if (mode === "wrong_revision") answer.payload["workflow_revision"] = "d".repeat(64);
    if (mode === "wrong_options") answer.payload["options"] = ["确认放行", "OTHER"];
    if (mode === "wrong_index") answer.payload["chosen_index"] = 1;
    if (mode === "not_human") answer.actor.kind = "agent";
    if (mode === "before_wait") answer.seq = 1;
    expect(project_active_run_wait(row, [started(), wait, answer], run_id).status).toBe("waiting_human");
  });
  it.each(["gate.invalidated", "gate.resolved", "workflow.run.cancelled"])("%s 消除当前等待", type => {
    const wait = waiting(); const end = event(type, { node_id: "review", gate_id: "human", waiting_event_id: wait.event_id, run_id }, 3);
    expect(project_active_run_wait(row, [started(), wait, end], run_id).status).toBe("running");
  });
  it("其他 run 的迟到取消不抹去当前等待，其他版本等待不污染当前", () => {
    const wait = waiting(); const old_cancel = event("workflow.run.cancelled", { run_id: ulid() }, 3);
    expect(project_active_run_wait(row, [started(), wait, old_cancel], run_id).status).toBe("waiting_human");
    expect(project_active_run_wait(row, [started(), waiting({ workflow_revision: "c".repeat(64) })], run_id).status).toBe("running");
  });
  it.each(["completed", "cancelled", "failed", "blocked"] as const)("%s 终态或历史/无活动登记不借用新等待", status => {
    const terminal = { ...row, status, finished_at: row.started_at, error: "original" };
    expect(project_active_run_wait(terminal, [started(), waiting()], run_id)).toEqual(terminal);
    expect(project_active_run_wait(row, [started(), waiting()], null)).toEqual(row);
    expect(project_active_run_wait(row, [started(), waiting()], ulid())).toEqual(row);
  });
  it.each(["missing_start", "duplicate_start", "wrong_binding", "missing_options", "missing_hash"])("%s 不用旧索引填充无法核验的活动状态", mode => {
    const start = started(); const wait = waiting(); const events = mode === "missing_start" ? [wait] : [start, wait];
    if (mode === "duplicate_start") events.unshift(started());
    if (mode === "wrong_binding") start.payload["sdlc_version"] = 2;
    if (mode === "missing_options") delete wait.payload["options"];
    if (mode === "missing_hash") delete wait.payload["evaluation_hash"];
    expect(() => project_active_run_wait(row, events, run_id)).toThrow(/不可验证/);
  });
  it("多个等待逐项核验，前一个等待不能掩盖另一个坏结构；只答一个仍等待其他人审", () => {
    const first = waiting(); const second = waiting({ gate_id: "other-human" }); second.seq = 3;
    expect(project_active_run_wait(row, [started(), first, second, { ...decision(first), seq: 4 }], run_id).status).toBe("waiting_human");
    delete (second.payload as Record<string, unknown>)["evaluation_hash"];
    expect(() => project_active_run_wait(row, [started(), first, second], run_id)).toThrow(/不可验证/);
  });
});
