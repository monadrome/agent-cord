import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDefSchema, type WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import type { SessionHandle, AgentDriver } from "../../src/core/ports.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { executionInputHash, readApprovalContextHash } from "../../src/coordinator/checkpoint.js";
import { buildContextPack } from "../../src/coordinator/context-pack.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { readCoordinationSnapshot, buildCoordinationDocuments } from "../../src/coordinator/coordination-context.js";

let root: string; let session: SessionHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-input-scope-")); session = await initSession(join(root, "cord"), "REQ-INPUT-SCOPE");
  for (const [file, content] of Object.entries({ "prd.md": "PRD_CURRENT", "plan.md": "UPSTREAM_PLAN", "adr.md": "MANUAL_ADR",
    "findings.md": "DOWNSTREAM_REPORT", "unrelated.md": "SIDE_OUTPUT", "review.md": "OWN_ARTIFACT", "manual.md": "EXPLICIT_MANUAL", "gate.md": "GATE_DOCUMENT" })) {
    await writeFile(join(session.dir, file), "# " + content + "\n");
  }
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function definition(scope = true): WorkflowDef {
  return WorkflowDefSchema.parse({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "scope-flow" }, spec: { nodes: [
    { id: "plan", artifact: "plan.md" },
    { id: "bridge", depends_on: ["plan"] },
    { id: "deliver", artifact: "review.md", depends_on: ["bridge"], run: { agent: "fake", ...(scope ? { input_scope: { kind: "dependencies", documents: ["manual.md"] } } : {}) },
      gates: [{ id: "check", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "doc-has-section", with: { path: "gate.md", heading: "Gate" } }], pass: { human_confirm: false }, on_fail: "block" }] },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"] },
    { id: "side", artifact: "unrelated.md" },
  ] } });
}
const node = (def: WorkflowDef) => def.spec.nodes.find(item => item.id === "deliver")!;
const snapshot = (def: WorkflowDef) => readSnapshot(session, { workflow_id: def.metadata.id, files: [...def.spec.nodes.flatMap(item => item.artifact === undefined ? [] : [item.artifact]), "manual.md", "gate.md"] });
const input_hash = async (def: WorkflowDef) => executionInputHash(def, node(def), await snapshot(def));
async function exit(def: WorkflowDef, node_id: string) { await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.node.exited", schema_version: "1",
  actor: { kind: "system", id: "fixture" }, correlation_id: node_id, source: { adapter: "fixture" }, payload: { workflow_id: def.metadata.id, node_id } }); }

describe("节点声明依赖输入", () => {
  it("started后取消不因额外核验再派发worker或写报告", async () => {
    const def = definition(); const controller = new AbortController(); let calls = 0;
    const driver: AgentDriver = { name: "fake", async *run() { calls++; yield { type: "result", data: { text: "# LATE_OUTPUT\n" } }; }, async *resume() {} };
    const original = session.events.append.bind(session.events);
    vi.spyOn(session.events, "append").mockImplementation(async draft => { const event = await original(draft); if (draft.type === "agent.task.started") controller.abort(); return event; });
    expect((await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }).runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver", signal: controller.signal })).status).toBe("cancelled");
    expect(calls).toBe(0); expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe("# OWN_ARTIFACT\n");
  });

  it.each(["cycle", "unknown"])("输入依赖%s无法核验时零派发，不能猜测省略上游", async mode => {
    const def = definition(); const bridge = def.spec.nodes.find(item => item.id === "bridge")!;
    bridge.depends_on = [mode === "cycle" ? "deliver" : "unknown"];
    let calls = 0;
    const driver: AgentDriver = { name: "fake", async *run() { calls++; yield { type: "result", data: { text: "# OUTPUT\n" } }; }, async *resume() {} };
    expect((await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }).runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("failed"); expect(calls).toBe(0);
  });
  it("独立协调保留全部下游/显式文档，正文和新鲜度均观察最新材料", async () => {
    const def = definition(); const before = await readCoordinationSnapshot(def, session);
    expect(before.docs.map(doc => doc.file)).toEqual(expect.arrayContaining(["findings.md", "unrelated.md", "manual.md", "gate.md"]));
    const body = buildCoordinationDocuments(before.docs, 10000); expect(body).toContain("DOWNSTREAM_REPORT"); expect(body).toContain("EXPLICIT_MANUAL");
    await writeFile(join(session.dir, "manual.md"), "# MANUAL_LATEST\n");
    const after = await readCoordinationSnapshot(def, session); expect(after.snapshot_id).not.toBe(before.snapshot_id);
    expect(buildCoordinationDocuments(after.docs, 10000)).toContain("MANUAL_LATEST");
  });
  it("started落盘期间声明输入变化时零driver派发，修复后重新读取可执行", async () => {
    const def = definition(); let calls = 0;
    const driver: AgentDriver = { name: "fake", async *run() { calls++; yield { type: "result", data: { text: "# OUTPUT\n" } }; }, async *resume() {} };
    const original = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await original(draft);
      if (draft.type === "agent.task.started") await writeFile(join(session.dir, "manual.md"), "# CHANGED_AFTER_START\n");
      return event;
    });
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("failed"); expect(calls).toBe(0);
    mock.mockRestore();
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("ok"); expect(calls).toBe(1);
  });

  it("scope当前完成可以复用，无关输出变化不重做，额外输入/自产输出/旧域无法复用", async () => {
    const def = definition(); let calls = 0;
    const driver: AgentDriver = { name: "fake", async *run() { calls++; yield { type: "result", data: { text: "# OUTPUT\n" } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }); const ctx = { workflow_id: def.metadata.id, node_id: "deliver" };
    expect((await runner.runNode(node(def), session, ctx)).status).toBe("ok");
    const completed = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed").at(-1)!;
    expect(await runner.isCompletionReusable!(node(def), session, ctx, completed)).toBe(true);
    await writeFile(join(session.dir, "findings.md"), "# NEW_DOWNSTREAM\n");
    expect(await runner.isCompletionReusable!(node(def), session, ctx, completed)).toBe(true);
    expect(await runner.isCompletionReusable!(node(def), session, ctx, { ...completed, payload: { ...completed.payload, execution_input_hash: "a".repeat(64) } })).toBe(false);
    await writeFile(join(session.dir, "manual.md"), "# NEW_MANUAL\n"); expect(await runner.isCompletionReusable!(node(def), session, ctx, completed)).toBe(false);
    await writeFile(join(session.dir, "manual.md"), "# EXPLICIT_MANUAL\n");
    await writeFile(join(session.dir, "review.md"), "# ALTERED_OWN\n"); expect(await runner.isCompletionReusable!(node(def), session, ctx, completed)).toBe(false);
    expect(calls).toBe(1);
  });
  it("发布保留严格scope/额外文档，未知mode/键/重复/越界文档拒绝", () => {
    expect(node(definition()).run).toMatchObject({ input_scope: { kind: "dependencies", documents: ["manual.md"] } });
    for (const scope of [{ kind: "auto" }, { kind: "dependencies", extra: true }, { kind: "dependencies", documents: ["../escape.md"] },
      { kind: "dependencies", documents: ["same.md", "same.md"] }]) {
      const def = definition(false); (node(def).run as unknown as Record<string, unknown>)["input_scope"] = scope;
      expect(WorkflowDefSchema.safeParse(def).success).toBe(false);
    }
  });

  it.each(["findings.md", "unrelated.md"])("%s下游/无关输出变化不改变上游执行与自测/审批输入", async file => {
    const def = definition(); const before = await input_hash(def); const approval = await readApprovalContextHash(def, node(def), session);
    await writeFile(join(session.dir, file), "# OUTPUT_UPDATED\n");
    expect(await input_hash(def)).toBe(before); expect(await readApprovalContextHash(def, node(def), session)).toBe(approval);
  });

  it.each(["prd.md", "plan.md", "adr.md", "manual.md", "gate.md"])("%s需求/传递上游/手工/额外/检查文档变化都使旧输入失效", async file => {
    const def = definition(); const before = await input_hash(def); const approval = await readApprovalContextHash(def, node(def), session);
    await writeFile(join(session.dir, file), "# CHANGED_INPUT\n");
    expect(await input_hash(def)).not.toBe(before); expect(await readApprovalContextHash(def, node(def), session)).not.toBe(approval);
  });

  it("当前自产artifact只改变approval身份，不能使自己的执行完成自行失效", async () => {
    const def = definition(); const before = await input_hash(def); const approval = await readApprovalContextHash(def, node(def), session);
    await writeFile(join(session.dir, "review.md"), "# NEW_OWN_OUTPUT\n");
    expect(await input_hash(def)).toBe(before); expect(await readApprovalContextHash(def, node(def), session)).not.toBe(approval);
  });

  it("只有上游退出参与稳定执行hash，无关进度保持不变", async () => {
    const def = definition(); const before = await input_hash(def); await exit(def, "side"); expect(await input_hash(def)).toBe(before);
    await exit(def, "plan"); expect(await input_hash(def)).not.toBe(before);
  });

  it("正文与定位符使用同一集合，排除下游，保留额外/文件gate/upstream信息", async () => {
    const def = definition(); await exit(def, "plan");
    const prompt = buildContextPack(def, node(def), await snapshot(def));
    expect(prompt).toContain("PRD_CURRENT"); expect(prompt).toContain("UPSTREAM_PLAN"); expect(prompt).toContain("manual.md"); expect(prompt).toContain("gate.md");
    expect(prompt).toContain("EXPLICIT_MANUAL"); expect(prompt).toContain("GATE_DOCUMENT"); expect(prompt).toContain("MANUAL_ADR");
    expect(prompt).not.toContain("findings.md"); expect(prompt).not.toContain("unrelated.md");
  });

  it("PRD永远绑定，即使其他分支也声明该路径；scope补充正文遵守总预算", async () => {
    const def = definition(); def.spec.nodes.find(item => item.id === "side")!.artifact = "prd.md";
    const before = await input_hash(def); await writeFile(join(session.dir, "prd.md"), "# ALWAYS_CURRENT_PRD\n"); expect(await input_hash(def)).not.toBe(before);
    await writeFile(join(session.dir, "manual.md"), "MANUAL_HEAD\n" + "x".repeat(40000) + "\nMANUAL_TAIL");
    const prompt = buildContextPack(def, node(def), await readCoordinationSnapshot(def, session), { maxPackChars: 5000 });
    expect(prompt.length).toBeLessThanOrEqual(5000); expect(prompt).toContain("MANUAL_HEAD"); expect(prompt).toContain("MANUAL_TAIL");
  });

  it("实际runner不读取未声明下游链接，额外输入链接则fail-closed且不派发", async () => {
    const def = definition(); const prompts: string[] = [];
    const driver: AgentDriver = { name: "fake", async *run(task) { prompts.push(task.prompt); yield { type: "result", data: { text: "# NEW_OUTPUT\n" } }; }, async *resume() {} };
    await rm(join(session.dir, "findings.md")); await symlink(join(root, "private.md"), join(session.dir, "findings.md"));
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("ok"); expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("findings.md");
    await rm(join(session.dir, "manual.md")); await symlink(join(root, "private.md"), join(session.dir, "manual.md"));
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("failed"); expect(prompts).toHaveLength(1);
  });

  it("共享artifact若由自身或上游声明，不能因也属于下游而被排除", async () => {
    const def = definition(); def.spec.nodes.find(item => item.id === "side")!.artifact = "plan.md";
    const before = await input_hash(def); await writeFile(join(session.dir, "plan.md"), "# SHARED_UPDATED\n"); expect(await input_hash(def)).not.toBe(before);
    expect(buildContextPack(def, node(def), await snapshot(def))).toContain("plan.md");
  });

  it("显式额外documents可绑定其他分支产物，省略scope旧全部文档语义保持", async () => {
    const scoped = definition(); node(scoped).run!.input_scope!.documents.push("unrelated.md");
    const before = await input_hash(scoped); await writeFile(join(session.dir, "unrelated.md"), "# EXPLICIT_SIDE_UPDATED\n"); expect(await input_hash(scoped)).not.toBe(before);
    const legacy = definition(false); const old = await input_hash(legacy); await writeFile(join(session.dir, "findings.md"), "# LEGACY_UPDATED\n"); expect(await input_hash(legacy)).not.toBe(old);
  });

  it.each(["missing", "placeholder", "empty"])("额外输入%s不派发，修复原文后可恢复", async mode => {
    const def = definition(); const prompts: string[] = [];
    const driver: AgentDriver = { name: "fake", async *run(task) { prompts.push(task.prompt); yield { type: "result", data: { text: "# NEW_OUTPUT\n" } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    if (mode === "missing") await rm(join(session.dir, "manual.md"));
    else await writeFile(join(session.dir, "manual.md"), mode === "empty" ? "" : "<!-- 占位文档 -->");
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("failed"); expect(prompts).toHaveLength(0);
    await writeFile(join(session.dir, "manual.md"), "# RESTORED_MANUAL\n");
    expect((await runner.runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" })).status).toBe("ok"); expect(prompts).toHaveLength(1);
  });

  it.each(["manual.md", "findings.md"])("worker在途%s变更只对已声明输入拒绝代写，不误拒绝下游", async file => {
    const def = definition(); const driver: AgentDriver = { name: "fake", async *run() {
      await writeFile(join(session.dir, file), "# CHANGED_DURING_TASK\n"); yield { type: "result", data: { text: "# LATE_OUTPUT\n" } };
    }, async *resume() {} };
    const before = await readFile(join(session.dir, "review.md"), "utf8");
    const outcome = await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }).runNode(node(def), session, { workflow_id: def.metadata.id, node_id: "deliver" });
    expect(outcome.status).toBe(file === "manual.md" ? "failed" : "ok");
    const completion = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed").at(-1)!;
    if (file === "manual.md") { expect(completion.payload).toMatchObject({ retryable: false, failure_stage: "snapshot" }); expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe(before); }
    else expect(await readFile(join(session.dir, "review.md"), "utf8")).toContain("LATE_OUTPUT");
  });
});
