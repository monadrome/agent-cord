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
