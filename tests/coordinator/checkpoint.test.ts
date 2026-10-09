/** 未退出节点 checkpoint 的稳定输入和产物校验（ADR-0030）。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import type { AgentDriver, SessionHandle } from "../../src/core/ports.js";
import type { EventEnvelope, WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { createExecutor } from "../../src/workflow/executor.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

let root: string;
let session: SessionHandle;
const def: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "checkpoint" },
  spec: { nodes: [{ id: "plan", artifact: "plan.md", depends_on: [], run: { agent: "worker", readonly: false }, gates: [{
    id: "review", role: { initiators: [], approvers: [] }, attach: { node: "plan", when: "post", triggers: [] },
    checks: [{ ref: "file-nonempty", with: { path: "plan.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block", write_back: [],
  }] }] },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-checkpoint-"));
  session = await initSession(join(root, "cord"), "REQ-CHECKPOINT");
  await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_ONE");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function worker(): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return { name: "worker", prompts, async *run(task) {
    prompts.push(task.prompt);
    yield { type: "result", data: { text: `# PLAN_ATTEMPT_${prompts.length}` } };
  }, async *resume() {} };
}
function runner(driver: AgentDriver, workflow = def, maxPackChars?: number) {
  return createNodeRunner(workflow, { resolveDriver: () => driver, workspaceRoot: root, ...(maxPackChars !== undefined ? { maxPackChars } : {}) });
}
const crash = { ask: async (): Promise<string> => { throw new Error("interrupted at approval"); } };
const approve = { ask: async (_q: string, options: string[]): Promise<string> => options[0]! };
async function completion(): Promise<EventEnvelope> {
  return (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed")!;
}

describe("恢复 checkpoint", () => {
  it("旧前缀策略的完整成功 checkpoint 不可复用，新策略重跑后可恢复", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    const prior = await completion(); const node = def.spec.nodes[0]!;
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id, files: ["plan.md"] });
    const legacy_hash = sha256Hex(canonicalJson({ domain: "cord.execution-input.v2", agent_configuration_hash: null, workflow: def, node,
      req_id: snapshot.req_id, title: snapshot.title, max_pack_chars: 60_000,
      docs: snapshot.docs.filter((doc) => doc.file !== node.artifact).map(({ file, exists, content_hash }) => ({ file, exists, content_hash })), ledger: snapshot.ledger,
      exited: snapshot.workflow.exited.filter((id) => id !== node.id) }));
    const old = { ...prior, payload: { ...prior.payload, execution_input_hash: legacy_hash } };
    expect(await nodeRunner.isCompletionReusable!(node, session, { workflow_id: def.metadata.id, node_id: node.id }, old)).toBe(false);
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.completed", schema_version: "1", actor: { kind: "system", id: "legacy" }, correlation_id: node.id,
      payload: old.payload, source: { adapter: "test" } });
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(2);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(2);
  });

  it("原完成重试编号超过上限时重跑，修复后的完成仍可跨 run 复用", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.completed", schema_version: "1", actor: { kind: "system", id: "fixture" }, correlation_id: "plan",
      payload: { ...prior.payload, attempt: 3, max_attempts: 2 }, source: { adapter: "test" } });
    const invalid = (await session.events.readOrdered()).at(-1)!;
    expect(await nodeRunner.isCompletionReusable!(def.spec.nodes[0]!, session, { workflow_id: def.metadata.id, node_id: "plan" }, invalid)).toBe(false);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(2);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused")).toHaveLength(0);
    const repaired = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed").at(-1)!;
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(2);
    expect((await session.events.readOrdered()).find((event) => event.type === "agent.task.reused")?.payload["completion_event_id"]).toBe(repaired.event_id);
  });

  it("原完成与当前调用的流程/节点元信息必须一致，不能只凭 hash 复用", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    const node = def.spec.nodes[0]!;
    const ctx = { workflow_id: def.metadata.id, node_id: node.id };
    expect(await nodeRunner.isCompletionReusable!(node, session, ctx, prior)).toBe(true);
    for (const overrides of [{ workflow_id: "other" }, { node_id: "other" }]) {
      expect(await nodeRunner.isCompletionReusable!(node, session, ctx, { ...prior, payload: { ...(prior.payload as Record<string, unknown>), ...overrides } })).toBe(false);
      expect(await nodeRunner.isCompletionReusable!(node, session, { ...ctx, ...overrides }, prior)).toBe(false);
    }
  });

  it("同 run 原生完成直接恢复，不伪造新的复用或完成", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    const executor = createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() });
    for (let index = 0; index < 2; index++) await expect(executor.run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused")).toHaveLength(0);
  });

  it("旧任务无 run_id 可在明确新 run 下记录验证后的复用，不猜测原 run", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash }).run(def, session)).rejects.toThrow();
    const prior = await completion(); const run_id = ulid();
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).find((event) => event.type === "agent.task.reused")?.payload).toMatchObject({ run_id, completion_event_id: prior.event_id });
    expect(prior.payload).not.toHaveProperty("run_id");
  });

  it("坏最新复用不能被去重当作成功，重新核验后写入修复事实", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    const run_id = ulid(); const executor = createExecutor({ nodeRunner, humanGate: crash, run_id });
    await expect(executor.run(def, session)).rejects.toThrow();
    const prior = (await session.events.readOrdered()).find((event) => event.type === "agent.task.reused")!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.reused", schema_version: "1", actor: { kind: "system", id: "fixture" }, correlation_id: "plan",
      payload: { ...(prior.payload as Record<string, unknown>), execution_input_hash: "d".repeat(64) }, source: { adapter: "test" } });
    await expect(executor.run(def, session)).rejects.toThrow();
    const reused = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused");
    expect(reused).toHaveLength(3);
    expect(reused.at(-1)?.payload["execution_input_hash"]).toBe(prior.payload["execution_input_hash"]);
    expect(driver.prompts).toHaveLength(1);
  });

  it("跨 run 复用记录原完成来源，同 run 连续恢复只记录一次且不重跑 worker", async () => {
    const driver = worker();
    const nodeRunner = runner(driver);
    const first_run = ulid(); const second_run = ulid();
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: first_run }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    const executor = createExecutor({ nodeRunner, humanGate: crash, run_id: second_run });
    for (let index = 0; index < 3; index++) await expect(executor.run(def, session)).rejects.toThrow();
    const reused = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused");
    expect(reused).toHaveLength(1);
    expect(reused[0]?.payload).toMatchObject({ run_id: second_run, node_id: "plan", completion_event_id: prior.event_id,
      execution_input_hash: prior.payload["execution_input_hash"] });
    expect(driver.prompts).toHaveLength(1);
    await createExecutor({ nodeRunner, humanGate: approve, run_id: second_run }).run(def, session);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused")).toHaveLength(1);
  });

  it("复用事实追加失败不能进入 gate，修复后可恢复且仍不重跑 worker", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    const append = session.events.append.bind(session.events);
    const spy = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "agent.task.reused" ? Promise.reject(new Error("reuse append unavailable")) : append(draft));
    const ask = vi.fn(approve.ask);
    const second_run = ulid();
    await expect(createExecutor({ nodeRunner, humanGate: { ask }, run_id: second_run }).run(def, session)).rejects.toThrow("reuse append unavailable");
    expect(ask).not.toHaveBeenCalled();
    expect(driver.prompts).toHaveLength(1);
    spy.mockRestore();
    await createExecutor({ nodeRunner, humanGate: { ask }, run_id: second_run }).run(def, session);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(driver.prompts).toHaveLength(1);
  });

  it("输入或产物变化的跨 run checkpoint 仍重跑，不记录伪复用", async () => {
    const driver = worker(); const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_TWO");
    await expect(createExecutor({ nodeRunner, humanGate: crash, run_id: ulid() }).run(def, session)).rejects.toThrow();
    expect(driver.prompts).toHaveLength(2);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.reused")).toHaveLength(0);
  });

  it("同输入连续中断恢复保持一次 worker 调用，复用同一审批事实", async () => {
    const driver = worker();
    const nodeRunner = runner(driver);
    const executor = createExecutor({ nodeRunner, humanGate: crash });
    for (let i = 0; i < 3; i++) await expect(executor.run(def, session)).rejects.toThrow("interrupted at approval");
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).filter((event) => event.type === "gate.waiting")).toHaveLength(1);
    await createExecutor({ nodeRunner, humanGate: approve }).run(def, session);
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).filter((event) => event.type === "workflow.node.exited")).toHaveLength(1);
  });

  it.each(["prd", "ledger", "artifact"])("中断期间 %s 变化使旧 checkpoint 无效，重跑后只审批新产物", async (change) => {
    const driver = worker();
    const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    if (change === "prd") await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_TWO");
    if (change === "artifact") await writeFile(join(session.dir, "plan.md"), "# MANUALLY_CHANGED");
    if (change === "ledger") await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "ledger.entry.proposed", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null, payload: { entry_id: "C-1", title: "NEW_DECISION", anchors: [{ kind: "doc", anchor: "prd.md" }] }, source: { adapter: "test" } });
    expect(await nodeRunner.isCompletionReusable!(def.spec.nodes[0]!, session, { workflow_id: "checkpoint", node_id: "plan" }, prior)).toBe(false);
    await createExecutor({ nodeRunner, humanGate: approve }).run(def, session);
    expect(driver.prompts).toHaveLength(2);
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toContain("PLAN_ATTEMPT_2");
    const events = await session.events.readOrdered();
    expect(events.some((event) => event.type === "gate.invalidated")).toBe(true);
    if (change === "prd") expect(driver.prompts[1]).toContain("VERSION_TWO");
    if (change === "ledger") expect(driver.prompts[1]).toContain("NEW_DECISION");
  });

  it("完整文档截断后的尾部变化也使输入失效，控制事件不会使输入失效", async () => {
    await writeFile(join(session.dir, "prd.md"), "A".repeat(21_000) + "TAIL_A");
    const driver = worker();
    const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    const ctx = { workflow_id: "checkpoint", node_id: "plan" };
    expect(await nodeRunner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, prior)).toBe(true);
    await writeFile(join(session.dir, "prd.md"), "A".repeat(21_000) + "TAIL_B");
    expect(await nodeRunner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, prior)).toBe(false);
  });

  it("流程定义和上下文预算变化不复用旧任务；旧事件缺少 hash 也不复用", async () => {
    const driver = worker();
    const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash }).run(def, session)).rejects.toThrow();
    const prior = await completion();
    const ctx = { workflow_id: "checkpoint", node_id: "plan" };
    const changed: WorkflowDef = { ...def, metadata: { ...def.metadata, name: "modified definition" } };
    expect(await runner(driver, changed).isCompletionReusable!(changed.spec.nodes[0]!, session, ctx, prior)).toBe(false);
    expect(await runner(driver, def, 20_000).isCompletionReusable!(def.spec.nodes[0]!, session, ctx, prior)).toBe(false);
    const old_payload = { ...(prior.payload as Record<string, unknown>) };
    delete old_payload.execution_input_hash;
    expect(await nodeRunner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, { ...prior, payload: old_payload })).toBe(false);
  });

  it("同进程人工等待期间 PRD 变化，旧选择丢弃、worker 重跑，再确认新产物", async () => {
    const driver = worker();
    let asks = 0;
    await createExecutor({ nodeRunner: runner(driver), humanGate: { ask: async (_q, options) => {
      asks += 1;
      if (asks === 1) await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_TWO");
      return options[0]!;
    } } }).run(def, session);
    expect(asks).toBe(2);
    expect(driver.prompts).toHaveLength(2);
    expect(driver.prompts[1]).toContain("VERSION_TWO");
    expect((await session.events.readOrdered()).filter((event) => event.type === "gate.resolved")).toHaveLength(1);
  });

  it("复用校验读取失败时重新准备，若输入仍不可读则失败而不派发", async () => {
    const driver = worker();
    const nodeRunner = runner(driver);
    await expect(createExecutor({ nodeRunner, humanGate: crash }).run(def, session)).rejects.toThrow();
    await rm(join(session.dir, "prd.md"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(session.dir, "prd.md"));
    await createExecutor({ nodeRunner, humanGate: approve }).run(def, session);
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed").at(-1)?.payload).toMatchObject({ status: "failed", failure_stage: "snapshot" });
  });

  it("NodeRunner 未声明复用校验时，历史 ok 不能自动跳过", async () => {
    const driver = worker();
    await expect(createExecutor({ nodeRunner: runner(driver), humanGate: crash }).run(def, session)).rejects.toThrow();
    const runNode = vi.fn(async () => ({ status: "failed" as const }));
    await createExecutor({ nodeRunner: { runNode }, humanGate: approve }).run(def, session);
    expect(runNode).toHaveBeenCalledTimes(1);
  });
});
