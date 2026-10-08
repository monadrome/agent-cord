/** 只读报告的宿主文本通道：证据、冲突、恢复和旧语义。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDriver, AgentEvent, AgentTask, SessionHandle } from "../../src/core/ports.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { createExecutor } from "../../src/workflow/executor.js";
import { parseWorkflow } from "../../src/workflow/loader.js";
import YAML from "yaml";

let root: string;
let session: SessionHandle;
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "text-report" }, spec: { nodes: [
  { id: "review", artifact: "findings.md", depends_on: [], run: { agent: "reviewer", readonly: true, output: "text" }, gates: [] },
] } };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-text-output-")); session = await initSession(join(root, "cord"), "REQ-REPORT"); await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_ONE"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function worker(events: AgentEvent[] = [{ type: "result", data: { text: "# 验证报告\n\n## 结论\n证据已核验，待人工审核。" } }]) {
  const tasks: AgentTask[] = [];
  const driver: AgentDriver = { name: "reviewer", async *run(task) { tasks.push(task); yield* events; }, async *resume() {} };
  return { driver, tasks };
}
const ctx = { workflow_id: "text-report", node_id: "review" };
async function completed() { return (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed").at(-1)!; }

describe("文本产物通道", () => {
  it("readonly worker 仅返回完整报告，宿主代写并落产物证据，prompt 不要求 worker 写文件", async () => {
    const { driver, tasks } = worker(); const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(def.spec.nodes[0]!, session, ctx)).status).toBe("ok");
    expect(tasks[0]?.readonly).toBe(true);
    expect(tasks[0]?.prompt).toContain("最终回复");
    expect(tasks[0]?.prompt).not.toContain("把最终产物写入文件");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toContain("## 结论");
    expect((await completed()).payload).toMatchObject({ output: "text", artifact_written: true, written_by: "coordinator", artifact_changed: true });
  });
  it("只读输入 artifact 的缺省 auto 语义保持不变", async () => {
    const workflow: WorkflowDef = { ...def, spec: { nodes: [{ ...def.spec.nodes[0]!, run: { agent: "reviewer", readonly: true } }] } };
    const original = await readFile(join(session.dir, "findings.md"), "utf8"); const { driver } = worker();
    const runner = createNodeRunner(workflow, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(workflow.spec.nodes[0]!, session, ctx)).status).toBe("ok");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(original);
    expect((await completed()).payload).toMatchObject({ artifact_written: false, written_by: "none" });
  });
  it.each(["", "<!-- 占位文档 -->"])("空或占位结果不能产报告，保留原文件", async (text) => {
    const original = await readFile(join(session.dir, "findings.md"), "utf8"); const { driver } = worker([{ type: "result", data: { text } }]);
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(def.spec.nodes[0]!, session, ctx)).status).toBe("failed");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(original);
    expect((await completed()).payload).toMatchObject({ failure_stage: "artifact", artifact_written: false });
  });
  it("metadata 不参与报告，内容通道可在无显式最终字符串时 fallback", async () => {
    const { driver } = worker([{ type: "text", data: { text: "PRIVATE_METADATA", channel: "metadata" } }, { type: "text", data: { text: "# 实际报告\n## 结论\n待人工" } }, { type: "result", data: { text: null } }]);
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(def.spec.nodes[0]!, session, ctx)).status).toBe("ok");
    const report = await readFile(join(session.dir, "findings.md"), "utf8"); expect(report).toContain("实际报告"); expect(report).not.toContain("PRIVATE_METADATA");
  });
  it("观察到 artifact 变化时文本模式失败并保留并发编辑，不能改记 agent 自写", async () => {
    const { driver } = worker(); driver.run = async function* () { await writeFile(join(session.dir, "findings.md"), "# 并发的人工作品"); yield { type: "result", data: { text: "# 不应覆盖" } }; };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(def.spec.nodes[0]!, session, ctx)).status).toBe("failed");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe("# 并发的人工作品");
    expect((await completed()).payload).toMatchObject({ artifact_written: false, written_by: "none", failure_stage: "artifact", artifact_changed: true });
  });
  it("取消时不代写未完成报告", async () => {
    const controller = new AbortController(); const original = await readFile(join(session.dir, "findings.md"), "utf8"); const { driver } = worker();
    driver.run = async function* () { controller.abort(); yield { type: "result", data: { text: "# CANCELLED_REPORT" } }; };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(def.spec.nodes[0]!, session, { ...ctx, signal: controller.signal })).status).toBe("cancelled");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(original);
  });
  it("只有 metadata 或明确失败结果不能产成功报告，产物缺写入证据时不能复用", async () => {
    const original = await readFile(join(session.dir, "findings.md"), "utf8");
    for (const events of [
      [{ type: "text", data: { text: "PROTOCOL_ONLY", channel: "metadata" } }, { type: "result", data: { text: null } }],
      [{ type: "text", data: { text: "# PARTIAL_REPORT" } }, { type: "error", data: { kind: "agent", message: "评审失败" } }],
    ] as AgentEvent[][]) {
      const { driver } = worker(events); const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
      expect((await runner.runNode(def.spec.nodes[0]!, session, ctx)).status).toBe("failed");
      expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(original);
    }
    const { driver } = worker(); const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    await runner.runNode(def.spec.nodes[0]!, session, ctx); const prior = await completed();
    expect(await runner.isCompletionReusable!(def.spec.nodes[0]!, session, ctx, { ...prior, payload: { ...(prior.payload as Record<string, unknown>), artifact_written: false } })).toBe(false);
  });
  it("文本产物不会使自己的 checkpoint 失效，PRD 或报告变化仍失效", async () => {
    const { driver, tasks } = worker();
    const workflow: WorkflowDef = { ...def, spec: { nodes: [{ ...def.spec.nodes[0]!, gates: [{ id: "human", role: { initiators: [], approvers: [] }, attach: { node: "review", when: "post", triggers: [] }, checks: [{ ref: "file-nonempty", with: { path: "findings.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block", write_back: [] }] }] } };
    const node_runner = createNodeRunner(workflow, { resolveDriver: () => driver, workspaceRoot: root });
    const executor = createExecutor({ nodeRunner: node_runner, humanGate: { ask: async () => { throw new Error("审批中断"); } } });
    await expect(executor.run(workflow, session)).rejects.toThrow("审批中断");
    await expect(executor.run(workflow, session)).rejects.toThrow("审批中断"); expect(tasks).toHaveLength(1);
    const prior = await completed(); expect(await node_runner.isCompletionReusable!(workflow.spec.nodes[0]!, session, ctx, prior)).toBe(true);
    const report = await readFile(join(session.dir, "findings.md"), "utf8"); await writeFile(join(session.dir, "findings.md"), report + "\n人工改动");
    expect(await node_runner.isCompletionReusable!(workflow.spec.nodes[0]!, session, ctx, prior)).toBe(false);
    await writeFile(join(session.dir, "findings.md"), report); await writeFile(join(session.dir, "prd.md"), "# VERSION_TWO");
    expect(await node_runner.isCompletionReusable!(workflow.spec.nodes[0]!, session, ctx, prior)).toBe(false);
  });
  it("text 无 artifact 的 YAML 与直接节点调用都拒绝，不派发 worker", async () => {
    const { artifact: _artifact, ...node } = def.spec.nodes[0]!;
    const workflow = { ...def, spec: { nodes: [node] } };
    expect(() => parseWorkflow(YAML.stringify(workflow))).toThrow(/artifact/);
    const { driver, tasks } = worker(); const runner = createNodeRunner(workflow, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(node, session, ctx)).status).toBe("failed"); expect(tasks).toHaveLength(0);
    expect((await completed()).payload).toMatchObject({ failure_stage: "configuration", retryable: false });
  });
});
