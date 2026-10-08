/** 只读 worker 源码输入的恢复、在途变更与写回前校验。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDriver, SessionHandle } from "../../src/core/ports.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { createExecutor } from "../../src/workflow/executor.js";

let root: string;
let session: SessionHandle;
const def: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "source-review" },
  spec: { nodes: [{
    id: "review", artifact: "findings.md", depends_on: [], run: { agent: "reviewer", readonly: true, output: "text" },
    gates: [{ id: "human", role: { initiators: [], approvers: [] }, attach: { node: "review", when: "post", triggers: [] },
      checks: [{ ref: "doc-has-section", with: { path: "findings.md", heading: "结论" } }],
      pass: { require: "all", human_confirm: true }, on_fail: "block", write_back: [] }],
  }] },
};
const ctx = { workflow_id: "source-review", node_id: "review" };
const source_a = "a".repeat(64);
const source_b = "b".repeat(64);
const crash = { ask: async (): Promise<string> => { throw new Error("人审中断"); } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-worker-source-"));
  session = await initSession(join(root, "cord"), "REQ-SOURCE-REVIEW");
  await writeFile(join(session.dir, "prd.md"), "# PRD\n只读核验当前代码");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function completions() { return (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed"); }

function worker(on_run: () => void | Promise<void> = () => {}) {
  const calls: string[] = [];
  const driver: AgentDriver = {
    name: "reviewer", configuration_hash: "c".repeat(64),
    async *run(task) {
      calls.push(task.prompt);
      await on_run();
      yield { type: "result", data: { text: `# 核验报告\n\n## 结论\n第 ${calls.length} 次评审`, session_id: `review-${calls.length}` } };
    },
    async *resume() {},
  };
  return { driver, calls };
}

describe("只读 worker 源码新鲜度", () => {
  it("相同源码可复用，源码变化使未退出评审重新执行并替换旧报告", async () => {
    let source_hash = source_a;
    const { driver, calls } = worker();
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => source_hash });
    await expect(createExecutor({ nodeRunner: runner, humanGate: crash }).run(def, session)).rejects.toThrow("人审中断");
    const old = (await completions())[0]!;
    expect(await runner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, old)).toBe(true);
    const incomplete = { ...(old.payload as Record<string, unknown>) };
    delete incomplete.source_hash;
    expect(await runner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, { ...old, payload: incomplete })).toBe(false);
    expect((await session.events.readOrdered()).find((event) => event.type === "agent.task.started")?.payload).toMatchObject({ source_hash: source_a });
    source_hash = source_b;
    expect(await runner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, old)).toBe(false);
    await expect(createExecutor({ nodeRunner: runner, humanGate: crash }).run(def, session)).rejects.toThrow("人审中断");
    expect(calls).toHaveLength(2);
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toContain("第 2 次评审");
    const tasks = await completions();
    expect(tasks[0]!.payload).toMatchObject({ source_hash: source_a, status: "ok" });
    expect(tasks[1]!.payload).toMatchObject({ source_hash: source_b, status: "ok" });
    expect((tasks[1]!.payload as any).execution_input_hash).not.toBe((tasks[0]!.payload as any).execution_input_hash);
    expect((await session.events.readOrdered()).some((event) => event.type === "gate.invalidated")).toBe(true);
  });

  it("人工等待期间源码改变，旧选择不用于旧报告，重新评审后再次确认", async () => {
    let source_hash = source_a;
    const { driver, calls } = worker();
    let asks = 0;
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => source_hash });
    await createExecutor({ nodeRunner: runner, humanGate: { ask: async (_question, options) => {
      if (++asks === 1) source_hash = source_b;
      return options[0]!;
    } } }).run(def, session);
    expect(asks).toBe(2);
    expect(calls).toHaveLength(2);
    expect((await session.events.readOrdered()).filter((event) => event.type === "gate.resolved")).toHaveLength(1);
    expect((await completions()).at(-1)?.payload).toMatchObject({ source_hash: source_b, status: "ok" });
  });

  it("执行期间源码变化不能代写报告，重跑使用新源码并保留失败事实", async () => {
    let source_hash = source_a;
    const { driver, calls } = worker(() => { source_hash = source_b; });
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => source_hash });
    const before = await readFile(join(session.dir, "findings.md"), "utf8");
    expect(await runner.runNode(def.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "failed" });
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(before);
    expect((await completions())[0]?.payload).toMatchObject({ status: "failed", source_hash: source_a, failure_stage: "snapshot", artifact_written: false });
    expect(await runner.runNode(def.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(2);
    expect((await completions()).map((event) => (event.payload as any).status)).toEqual(["failed", "ok"]);
  });

  it.each(["invalid", "unreadable"])("源码身份 %s 时记录快照失败且不派发 worker", async (mode) => {
    const { driver, calls } = worker();
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => {
      if (mode === "unreadable") throw new Error("输入不可读");
      return "not-a-hash";
    } });
    expect(await runner.runNode(def.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(0);
    expect((await completions())[0]?.payload).toMatchObject({ status: "failed", failure_stage: "snapshot" });
  });

  it.each([new Error("完成时源码不可读"), undefined])("完成时源码读取失败 %s 不写报告", async (failure) => {
    let read_count = 0;
    const { driver } = worker();
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => {
      if (++read_count > 1) throw failure;
      return source_a;
    } });
    const before = await readFile(join(session.dir, "findings.md"), "utf8");
    expect(await runner.runNode(def.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "failed" });
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(before);
    expect((await completions())[0]?.payload).toMatchObject({ failure_stage: "snapshot", artifact_written: false });
  });

  it("源码重检期间取消，不写报告也不记成功", async () => {
    const controller = new AbortController();
    let count = 0;
    const { driver } = worker();
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => {
      if (++count === 2) controller.abort();
      return source_a;
    } });
    const before = await readFile(join(session.dir, "findings.md"), "utf8");
    expect(await runner.runNode(def.spec.nodes[0]!, session, { ...ctx, signal: controller.signal })).toMatchObject({ status: "cancelled" });
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(before);
    expect((await completions())[0]?.payload).toMatchObject({ status: "cancelled", artifact_written: false });
  });

  it("新增源码绑定后旧无源码任务不复用，未提供钩子保持旧身份兼容", async () => {
    const { driver } = worker();
    const legacy = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver });
    expect(await legacy.runNode(def.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "ok" });
    const prior = (await completions())[0]!;
    expect(await legacy.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, prior)).toBe(true);
    const bound = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => source_a });
    expect(await bound.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, prior)).toBe(false);
  });

  it("可写 worker 改源码不会应用只读源码钩子", async () => {
    const writable = structuredClone(def);
    writable.spec.nodes[0]!.run!.readonly = false;
    const { driver } = worker();
    const runner = createNodeRunner(writable, { workspaceRoot: root, resolveDriver: () => driver, read_source_hash: async () => { throw new Error("可写节点不应读取"); } });
    expect(await runner.runNode(writable.spec.nodes[0]!, session, ctx)).toMatchObject({ status: "ok" });
    expect((await completions())[0]?.payload).not.toHaveProperty("source_hash");
  });
});
