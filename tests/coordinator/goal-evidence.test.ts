import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSession } from "../../src/core/session.js";
import { sha256Hex } from "../../src/core/hash.js";
import { WorkflowDefSchema, type EventEnvelope } from "../../src/core/schema.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { resolveGoalReadiness } from "../../src/coordinator/goal-evidence.js";
import { accumulateGoalUsage } from "../../src/coordinator/goal-usage.js";
import { source_manifest_hash } from "../../src/coordinator/goal-changes.js";

const def = WorkflowDefSchema.parse({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-evidence" }, spec: { nodes: [{ id: "deliver", artifact: "review.md",
  run: { agent: "fake", goal: { inputs: ["value.txt"], checks: [{ id: "test", bin: process.execPath, args: ["-e", "process.exit(0)"] }],
    review_changes: true, acceptance: [{ id: "baseline", criterion: "声明测试通过", checks: ["test"] }, { id: "delivery", criterion: "交付所需检查通过", checks: ["test"] }] } } }] } });
const node = def.spec.nodes[0]!;
const scope = { workflow_id: def.metadata.id, workflow_revision: "a".repeat(64), run_id: ulid() };
let root: string; let events: EventEnvelope[];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-goal-evidence-"));
  const session = await initSession(join(root, "cord"), "REQ-EVIDENCE");
  await writeFile(join(root, "value.txt"), "fixed");
  const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => ({ name: "fake", configuration_hash: "b".repeat(64),
    async *run() { await writeFile(join(root, "value.txt"), "changed"); yield { type: "result", data: { text: "## 变更\n当前实现。\n## 验收\n声明测试。\n## 风险\n仅 Draft。\n" } }; }, async *resume() {} }),
    read_verification_input: async () => {
      const source_manifest = [{ path: "value.txt", kind: "file" as const, mode: 0o644, content_hash: sha256Hex(await readFile(join(root, "value.txt"), "utf8")) }];
      return { input_hash: "c".repeat(64), source_hash: source_manifest_hash(source_manifest), source_manifest };
    } });
  expect((await runner.runNode(node, session, { ...scope, node_id: node.id })).status).toBe("ok");
  events = await session.events.readOrderedStrict!();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function ready(facts = events) { return facts.filter(event => event.type === "goal.attempt.completed").at(-1)!; }
function inspect(facts: EventEnvelope[]) { return resolveGoalReadiness(ready(facts), facts, node, scope); }
function patch(type: string, fields: Partial<EventEnvelope>, data?: Record<string, unknown>) {
  return events.map(event => event.type === type ? { ...event, ...fields, ...(data === undefined ? {} : { payload: { ...event.payload, ...data } }) } as EventEnvelope : event);
}

describe("共享 Goal ready 证据", () => {
  it.each(["missing", "wrong_source", "omitted", "forged_baseline", "forged_after"])("源码变更证据 %s 不可作为当前 ready", mode => {
    const evidence = structuredClone(ready().payload["change_evidence"]) as { baseline_event_id: string; baseline_source_hash: string; changes: Array<{ after: unknown }> };
    if (mode === "wrong_source") evidence.baseline_event_id = ulid();
    if (mode === "omitted") evidence.changes = [];
    if (mode === "forged_baseline") evidence.baseline_source_hash = "f".repeat(64);
    if (mode === "forged_after") evidence.changes[0]!.after = { path: "value.txt", kind: "file", mode: 0o644, content_hash: "f".repeat(64) };
    expect(inspect(patch("goal.attempt.completed", {}, { change_evidence: mode === "missing" ? undefined : evidence }))).toBeNull();
  });

  it("无首次源码基线、错误 actor 或基线变更时拒绝，不用最新代码补造", () => {
    expect(inspect(patch("goal.attempt.started", {}, { source_manifest: undefined }))).toBeNull();
    expect(inspect(patch("goal.attempt.started", { actor: { kind: "agent", id: "fake" } }))).toBeNull();
    expect(inspect(patch("goal.attempt.started", {}, { source_manifest: [{ path: "value.txt", kind: "file", mode: 0o644, content_hash: "f".repeat(64) }] }))).toBeNull();
    const old = structuredClone(node); delete old.run!.goal!.review_changes;
    expect(resolveGoalReadiness(ready(), events, old, scope)).toBeNull();
    const old_events = patch("goal.attempt.completed", {}, { change_evidence: undefined });
    expect(resolveGoalReadiness(ready(old_events), old_events, old, scope)).not.toBeNull();
  });
  it("ready 的 usage 预算缺失、篡改或超限不能复用", () => {
    const budget_node = structuredClone(node);
    budget_node.run!.goal!.usage_budget = { max_input_tokens: 10 };
    const tasks = patch("agent.task.completed", {}, { usage: { input_tokens: 3, output_tokens: 0, cost_usd: 0.1 } });
    const totals = accumulateGoalUsage(tasks, scope.run_id, node.id, { ...scope, session_id: "REQ-EVIDENCE", driver: "fake" });
    const valid = tasks.map(event => event.event_id === ready().event_id ? { ...event, payload: { ...event.payload, usage_budget: { max_input_tokens: 10 }, usage_totals: totals } } : event);
    expect(resolveGoalReadiness(ready(valid), valid, budget_node, scope)).not.toBeNull();
    for (const fields of [{ usage_totals: undefined }, { usage_budget: { max_input_tokens: 11 } }, { usage_totals: { ...totals, input_tokens: 0 } },
      { usage_totals: { ...totals, input_tokens: 11 } }, { usage_totals: { ...totals, unknown_input_tasks: 1 } }]) {
      const facts = valid.map(event => event.event_id === ready().event_id ? { ...event, payload: { ...event.payload, ...fields } } : event);
      expect(resolveGoalReadiness(ready(facts), facts, budget_node, scope)).toBeNull();
    }
    const facts = valid.map(event => event.type === "agent.task.completed" ? { ...event, payload: { ...event.payload, usage: { input_tokens: 11 } } } : event);
    expect(resolveGoalReadiness(ready(facts), facts, budget_node, scope)).toBeNull();
  });
  it("宿主生成完整条件映射，无清单历史兼容，不允许凭空声明覆盖", () => {
    const ready_event = ready(); const result = events.find(event => event.type === "verification.completed")!;
    expect(ready_event.payload["acceptance_evidence"]).toEqual([
      { acceptance_id: "baseline", verification_event_ids: [result.event_id] }, { acceptance_id: "delivery", verification_event_ids: [result.event_id] },
    ]);
    const legacy = structuredClone(node); delete legacy.run!.goal!.acceptance;
    expect(resolveGoalReadiness(ready_event, events, legacy, scope)).toBeNull();
    const legacy_events = patch("goal.attempt.completed", {}, { acceptance_evidence: undefined });
    expect(resolveGoalReadiness(ready(legacy_events), legacy_events, legacy, scope)).not.toBeNull();
    expect(inspect(legacy_events)).toBeNull();
  });
  it.each(["missing", "unknown", "wrong_event", "duplicate", "reordered", "extra_event"])("验收映射 %s 拒绝，不用单个 passed 替代完整覆盖", mode => {
    const original = structuredClone(ready().payload["acceptance_evidence"]) as Array<{ acceptance_id: string; verification_event_ids: string[] }>;
    if (mode === "missing") original.pop();
    if (mode === "unknown") original[0]!.acceptance_id = "foreign";
    if (mode === "wrong_event") original[0]!.verification_event_ids = [ulid()];
    if (mode === "duplicate") original[1] = original[0]!;
    if (mode === "reordered") original.reverse();
    if (mode === "extra_event") original[0]!.verification_event_ids.push(ulid());
    expect(inspect(patch("goal.attempt.completed", {}, { acceptance_evidence: original }))).toBeNull();
  });

  it("真正宿主测试和 worker 完成可解析，不要求补写前后指南 hash 相等", () => {
    const proof = inspect(events)!; expect(proof).not.toBeNull();
    expect(proof.completion.type).toBe("agent.task.completed");
    expect(proof.artifact_hash).not.toBe(proof.completion.payload["artifact_after_hash"]);
  });
  it.each([
    { actor: { kind: "agent", id: "fake" } }, { actor: { kind: "system", id: "foreign" } },
    { source: { adapter: "foreign" } }, { correlation_id: "other" },
  ])("ready 的非法宿主来源 %j 拒绝", fields => {
    expect(inspect(patch("goal.attempt.completed", fields as Partial<EventEnvelope>))).toBeNull();
  });
  it.each([
    { completion_event_id: "01ARZ3NDEKTSV4RRFFQ69G5F00" }, { verification_event_ids: [] },
    { attempt: 4 }, { max_attempts: 9 }, { artifact_hash: "invalid" },
  ])("ready 的坏引用/预算 %j 拒绝", fields => {
    expect(inspect(patch("goal.attempt.completed", {}, fields))).toBeNull();
  });
  it.each([
    { status: "failed" }, { failure_stage: "driver" }, { artifact_written: false }, { written_by: "none" },
    { artifact: "foreign.md" }, { artifact_after_hash: null }, { artifact_after_hash: "z".repeat(64) }, { attempt: 3, max_attempts: 2 },
    { run_id: ulid() }, { workflow_revision: "f".repeat(64) }, { node_id: "other" },
  ])("worker 完成 %j 不能冒充交付", fields => {
    expect(inspect(patch("agent.task.completed", {}, fields))).toBeNull();
  });
  it.each([
    { status: "failed" }, { exit_code: 1 }, { exit_code: null }, { command_hash: "f".repeat(64) },
    { input_hash: "f".repeat(64) }, { source_hash: "f".repeat(64) }, { run_id: ulid() }, { verification_id: "other" },
  ])("宿主验证 %j 不能证明当前声明通过", fields => {
    expect(inspect(patch("verification.completed", {}, fields))).toBeNull();
  });
  it("不存在/未来/先于 worker 的测试拒绝，不能只比较单个 seq", () => {
    const result = events.find(event => event.type === "verification.completed")!;
    const without = events.filter(event => event.event_id !== result.event_id);
    expect(inspect(without)).toBeNull();
    expect(inspect([...without, result])).toBeNull();
    const index = without.findIndex(event => event.type === "agent.task.completed");
    expect(inspect(without.toSpliced(index, 0, result))).toBeNull();
  });
  it("新的任务、验证或 Goal 已替换来源时旧 ready 无效", () => {
    const task = events.find(event => event.type === "agent.task.completed")!;
    const result = events.find(event => event.type === "verification.completed")!;
    const started = events.find(event => event.type === "goal.attempt.started")!;
    for (const event of [task, result, started]) expect(inspect([...events, { ...event, event_id: ulid() }])).toBeNull();
  });
  it("尝试缺启动、编号不一致或 worker 前未记录启动时拒绝", () => {
    const started = events.find(event => event.type === "goal.attempt.started")!;
    const without = events.filter(event => event.event_id !== started.event_id);
    expect(inspect(without)).toBeNull();
    expect(inspect(patch("goal.attempt.started", {}, { attempt: 2 }))).toBeNull();
    const index = without.findIndex(event => event.type === "verification.completed");
    expect(inspect(without.toSpliced(index, 0, started))).toBeNull();
  });
  it("重复 ready/worker/验证事件 ID 不能作为唯一来源", () => {
    for (const type of ["goal.attempt.completed", "agent.task.completed", "verification.completed"]) {
      const event = events.find(item => item.type === type)!;
      const index = events.indexOf(event);
      expect(inspect(events.toSpliced(index, 0, event))).toBeNull();
    }
  });
  it("不同 session 或取消当前 run 不复用，取消其他 run 不污染", () => {
    expect(inspect(patch("verification.completed", { session_id: "REQ-FOREIGN" }))).toBeNull();
    const event = { ...ready(), event_id: ulid(), type: "workflow.run.cancelled", payload: { ...scope } } as EventEnvelope;
    expect(inspect([...events, event])).toBeNull();
    expect(inspect([...events, { ...event, payload: { ...scope, run_id: ulid() } }])).not.toBeNull();
  });
});
