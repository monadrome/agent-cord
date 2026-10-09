/** 澄清来自合法人工答复与同批事实，进入最新输入而非模型私有历史。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSession } from "../../src/core/session.js";
import type { AgentDriver, SessionHandle } from "../../src/core/ports.js";
import type { EventEnvelope, WorkflowDef } from "../../src/core/schema.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { buildContextPack } from "../../src/coordinator/context-pack.js";
import { executionInputHash, readApprovalContextHash } from "../../src/coordinator/checkpoint.js";
import { coordinationInputHash, createContextSessionAgent } from "../../src/coordinator/session-agent.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";

const revision = "a".repeat(64);
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "clarify" }, spec: {
  nodes: [{ id: "review", depends_on: [], gates: [], run: { agent: "worker", readonly: true } }],
} };
const question_proposal = { summary: "需要澄清范围", next_action: { kind: "ask_human", question: "发布平台范围？", options: ["ONLY_MOBILE", "DESKTOP_AND_MOBILE"],
  reason: "需求范围不明确", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
let root: string; let session: SessionHandle;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-clarifications-")); session = await initSession(join(root, "cord"), "REQ-CLARIFY"); await writeFile(join(session.dir, "prd.md"), "# PRD\n平台范围待澄清"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function question(overrides: Record<string, unknown> = {}, type = "coordinator.round.completed") {
  const round_id = ulid();
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: round_id,
    payload: { round_id, workflow_id: def.metadata.id, workflow_revision: revision, driver: "model", status: "ok", proposal: question_proposal, error: null, duration_ms: 1, input_hash: "b".repeat(64), ...overrides }, source: { adapter: "test" } });
}
async function answer(original: EventEnvelope, payload: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.answered", schema_version: "1", actor: { kind: "human", id: "fixture" }, correlation_id: original.payload["round_id"] as string,
    payload: { round_id: original.payload["round_id"], workflow_id: def.metadata.id, workflow_revision: original.payload["workflow_revision"], completion_event_id: original.event_id,
      input_hash: original.payload["input_hash"], choice: "ONLY_MOBILE", ...payload }, source: { adapter: "test" }, ...envelope } as any);
}
const snapshot = () => readSnapshot(session, { workflow_id: def.metadata.id, workflow_revision: revision });
async function revoke(receipt: EventEnvelope, payload: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  const source = receipt.payload as Record<string, unknown>;
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.answer_revoked", schema_version: "1", actor: { kind: "human", id: "fixture" }, correlation_id: source["round_id"] as string,
    payload: { round_id: source["round_id"], workflow_id: source["workflow_id"], workflow_revision: source["workflow_revision"], answer_event_id: receipt.event_id, ...payload }, source: { adapter: "test" }, ...envelope } as any);
}

describe("协调澄清快照", () => {
  it("撤回最新同题答复形成未确定状态，不回退旧选择或复活无澄清身份", async () => {
    const empty = await snapshot();
    await answer(await question()); const receipt = await answer(await question(), { choice: "DESKTOP_AND_MOBILE" }); const active = await snapshot();
    const revoked = await revoke(receipt); const current = await snapshot();
    expect(current.clarifications).toEqual([{ event_id: revoked.event_id, round_id: (receipt.payload as any).round_id, question: question_proposal.next_action.question, choice: null, status: "revoked" }]);
    expect(coordinationInputHash(def, current, null)).not.toBe(coordinationInputHash(def, empty, null));
    expect(coordinationInputHash(def, current, null)).not.toBe(coordinationInputHash(def, active, null));
    const pack = buildContextPack(def, def.spec.nodes[0]!, current); expect(pack).toContain('"status":"revoked"'); expect(pack).not.toContain("ONLY_MOBILE"); expect(pack).not.toContain("DESKTOP_AND_MOBILE");
  });

  it.each([{ answer_event_id: ulid() }, { round_id: ulid() }])("撤回坏引用 %j 不可忽略", async (payload) => {
    const receipt = await answer(await question()); await revoke(receipt, payload); await expect(snapshot()).rejects.toThrow();
  });

  it("撤回必须来自人工且属于原答复范围", async () => {
    const receipt = await answer(await question()); await revoke(receipt, {}, { actor: { kind: "agent", id: "fixture" } }); await expect(snapshot()).rejects.toThrow();
  });

  it("撤回事件可解释未确定，原答复不能继续当作当前证据，worker checkpoint 失效", async () => {
    const receipt = await answer(await question()); const driver: AgentDriver = { name: "worker", async *run() { yield { type: "result", data: { text: "按选定范围评审" } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }); const node = def.spec.nodes[0]!;
    const context = { workflow_id: def.metadata.id, workflow_revision: revision, node_id: node.id };
    await runner.runNode(node, session, context); const completion = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed")!;
    const revoked = await revoke(receipt); expect(await runner.isCompletionReusable!(node, session, context, completion)).toBe(false);
    let source_id = revoked.event_id;
    const observer: AgentDriver = { name: "model", async *run(task) { expect(task.prompt).toContain('"status":"revoked"'); yield { type: "result", data: { text: JSON.stringify({ summary: "范围已撤回，等待重新确认", next_action: { kind: "wait", reason: "选择未确定", evidence: [{ source: "clarification", id: source_id }] }, risks: [] }) } }; }, async *resume() {} };
    const agent = createContextSessionAgent({ resolveDriver: () => observer, workspaceRoot: root });
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: "model", workflow_revision: revision })).toMatchObject({ status: "ok" });
    source_id = receipt.event_id;
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: "model", workflow_revision: revision })).toMatchObject({ status: "failed", proposal: null });
  });

  it.each(["future", "self"])("撤回 %s 引用不能生效", async (kind) => {
    const original = await question(); const receipt = await answer(original); const event_id = ulid(); const future_id = ulid();
    await revoke(receipt, { answer_event_id: kind === "self" ? event_id : future_id }, { event_id });
    if (kind === "future") await answer(original, {}, { event_id: future_id });
    await expect(snapshot()).rejects.toThrow();
  });

  it("人工答复进入快照和 worker，后续协调可引用答复事件，原问题完成不充当答复来源", async () => {
    const source = await question(); const receipt = await answer(source);
    const current = await snapshot();
    expect((current as any).clarifications).toEqual([{ event_id: receipt.event_id, round_id: source.payload["round_id"], question: question_proposal.next_action.question, choice: "ONLY_MOBILE" }]);
    expect(buildContextPack(def, def.spec.nodes[0]!, current)).toContain("ONLY_MOBILE");
    const output = (id: string) => ({ summary: "按人工澄清限定为移动端", next_action: { kind: "wait", reason: "等待人工 gate", evidence: [{ source: "clarification", id }] }, risks: [] });
    let evidence = receipt.event_id;
    const driver: AgentDriver = { name: "model", async *run(task) { expect(task.prompt).toContain("ONLY_MOBILE"); yield { type: "result", data: { text: JSON.stringify(output(evidence)) } }; }, async *resume() {} };
    const agent = createContextSessionAgent({ resolveDriver: () => driver, workspaceRoot: root });
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: "model", workflow_revision: revision })).toMatchObject({ status: "ok" });
    evidence = source.event_id;
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: "model", workflow_revision: revision })).toMatchObject({ status: "failed", proposal: null });
  });

  it("仅答复变化使协调、worker 和审批输入失效，空澄清不自行改变身份", async () => {
    const before = await snapshot();
    const approval = await readApprovalContextHash(def, def.spec.nodes[0]!, session, null, revision);
    expect(coordinationInputHash(def, before, null)).toBe(coordinationInputHash(def, { ...before, clarifications: [] } as any, null));
    expect(executionInputHash(def, def.spec.nodes[0]!, before)).toBe(executionInputHash(def, def.spec.nodes[0]!, { ...before, clarifications: [] } as any));
    await answer(await question()); const current = await snapshot();
    expect(coordinationInputHash(def, current, null)).not.toBe(coordinationInputHash(def, before, null));
    expect(executionInputHash(def, def.spec.nodes[0]!, current)).not.toBe(executionInputHash(def, def.spec.nodes[0]!, before));
    expect(await readApprovalContextHash(def, def.spec.nodes[0]!, session, null, revision)).not.toBe(approval);
  });

  it("同题保留最后选择，其他流程/版本不污染当前澄清", async () => {
    await answer(await question());
    const current = await answer(await question(), { choice: "DESKTOP_AND_MOBILE" });
    await answer(await question({ workflow_revision: "c".repeat(64) }));
    const result = await snapshot();
    expect((result as any).clarifications).toHaveLength(1);
    expect((result as any).clarifications[0]).toMatchObject({ event_id: current.event_id, choice: "DESKTOP_AND_MOBILE" });
  });

  it.each([
    { choice: "NOT_AN_OPTION" }, { input_hash: "c".repeat(64) }, { completion_event_id: ulid() }, { round_id: ulid() },
  ])("坏答复 %j 不能被丢弃后回退旧选择", async (payload) => {
    const original = await question(); await answer(original); await answer(original, payload);
    await expect(snapshot()).rejects.toThrow();
  });

  it.each([{ correlation_id: ulid() }, { actor: { kind: "agent", id: "fixture" } }])("答复 envelope %j 无法声明人工来源", async (value) => {
    await answer(await question(), {}, value); await expect(snapshot()).rejects.toThrow();
  });

  it.each(["wait", "failed", "replaced"])("引用 %s 完成时拒绝读取", async (kind) => {
    const original = await question(kind === "wait" ? { proposal: { ...question_proposal, next_action: { kind: "wait", reason: "等待", evidence: [{ source: "document", id: "prd.md" }] } } } :
      kind === "failed" ? { status: "failed", proposal: null, error: "失败" } : {});
    if (kind === "replaced") await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" },
      correlation_id: original.correlation_id, payload: { ...(original.payload as Record<string, unknown>), status: "failed", proposal: null, error: "替代完成" }, source: { adapter: "test" } });
    await answer(original); await expect(snapshot()).rejects.toThrow();
  });

  it("相关答复缺失 payload 也 fail-closed", async () => {
    const original = await question();
    await answer(original, {}, { payload: null });
    await expect(snapshot()).rejects.toThrow();
  });

  it.each(["future", "self"])("答复 %s 引用不能伪造原问题", async (kind) => {
    const original = await question(); const event_id = ulid(); const future_id = ulid();
    await answer(original, { completion_event_id: kind === "self" ? event_id : future_id }, { event_id });
    if (kind === "future") await session.events.append({ event_id: future_id, session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" },
      correlation_id: original.correlation_id, payload: original.payload, source: { adapter: "test" } });
    await expect(snapshot()).rejects.toThrow();
  });

  it("原生 worker 收到选择，新同题答复使旧 checkpoint 不可复用，不自行重跑", async () => {
    await answer(await question()); const tasks: string[] = [];
    const driver: AgentDriver = { name: "worker", async *run(task) { tasks.push(task.prompt); yield { type: "result", data: { text: "# 根据澄清评审" } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }); const node = def.spec.nodes[0]!;
    const context = { workflow_id: def.metadata.id, workflow_revision: revision, node_id: node.id };
    expect(await runner.runNode(node, session, context)).toMatchObject({ status: "ok" }); expect(tasks[0]).toContain("ONLY_MOBILE");
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed")!;
    expect(await runner.isCompletionReusable!(node, session, context, completed)).toBe(true);
    await answer(await question(), { choice: "DESKTOP_AND_MOBILE" });
    expect(await runner.isCompletionReusable!(node, session, context, completed)).toBe(false); expect(tasks).toHaveLength(1);
  });
});
