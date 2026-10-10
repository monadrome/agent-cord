import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { HeadlessDriver, initSession, type AgentCapabilities, type AgentDriver, type CoordinationAgents,
  type CoordinationProposal, type SessionHandle } from "../../src/index.js";
import { GateDefSchema, WorkflowDefSchema } from "../../src/core/schema.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { buildCoordinationPrompt, coordinationInputHash, parseCoordinationProposal } from "../../src/coordinator/session-agent.js";
import { createExecutor } from "../../src/workflow/executor.js";

const fixture = fileURLToPath(new URL("../driver/fixtures/fake-cli.mjs", import.meta.url));
const workflow = () => WorkflowDefSchema.parse({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "readonly-admission" },
  spec: { nodes: [{ id: "review", artifact: "review.md", run: { agent: "worker", readonly: true, require_readonly_mapping: true, output: "text",
    retry: { max_attempts: 3, backoff_ms: 0 } } }] } });
const caps: AgentCapabilities = { transport: "headless", evidence: "adapter", installation: "unchecked", launch_options: [],
  native_resume: "unsupported", readonly_launch: "mapped", goal: "host", workflow_resume: "authorized_unexited_goal" };
const advance: CoordinationProposal = { summary: "按当前需求评审", next_action: { kind: "advance", node_id: "review", reason: "参数映射已声明",
  evidence: [{ source: "workflow", id: "review" }] }, risks: [] };
let root: string; let session: SessionHandle;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-readonly-admission-")); session = await initSession(join(root, "cord"), "REQ-READONLY");
  await writeFile(join(session.dir, "prd.md"), "# PRD\nLATEST_READONLY_INPUT"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("节点只读映射要求", () => {
  it.each([false, true])("缺NodeRunner不跳过严格节点或post gate，原checkpoint=%s，恢复后才退出", async checkpoint => {
    const def = workflow(); const node = def.spec.nodes[0]!;
    node.gates = [GateDefSchema.parse({ id: "post-evidence", role: {}, attach: { node: node.id, when: "post" },
      checks: [{ ref: "observe-post" }], pass: { human_confirm: false }, on_fail: "block" })];
    const worker: AgentDriver = { name: "worker", configuration_hash: "a".repeat(64), capabilities: caps,
      async *run() { yield { type: "result", data: { text: "# 当前只读报告", session_id: null } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => worker });
    if (checkpoint) {
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.node.entered", schema_version: "1",
        actor: { kind: "system", id: "workflow-executor" }, correlation_id: node.id, source: { adapter: "workflow-executor" },
        payload: { workflow_id: def.metadata.id, node_id: node.id, artifact: node.artifact, resumed: false } });
      expect((await runner.runNode(node, session, { workflow_id: def.metadata.id, node_id: node.id })).status).toBe("ok");
    }
    let checks = 0; let asks = 0;
    const options = { humanGate: { async ask() { asks++; return "停止"; } },
      registry: { register() {}, get() { return { name: "observe-post", async check() {
        checks++; return { result: "pass" as const, anchors: [], reason: "测试用后置证据", confidence: 1 };
      } }; } } };
    await expect(createExecutor(options).run(def, session)).rejects.toThrow(/只读.*NodeRunner/);
    const blocked = await session.events.readOrdered();
    expect(blocked.some(event => ["workflow.node.exited", "gate.waiting", "gate.resolved", "agent.task.reused"].includes(event.type))).toBe(false);
    expect(checks).toBe(0); expect(asks).toBe(0);
    expect(blocked.filter(event => event.type === "agent.task.completed")).toHaveLength(checkpoint ? 1 : 0);
    await createExecutor({ ...options, nodeRunner: runner }).run(def, session);
    const completed = await session.events.readOrdered();
    expect(completed.filter(event => event.type === "workflow.node.exited")).toHaveLength(1);
    expect(completed.filter(event => event.type === "agent.task.completed")).toHaveLength(1);
    expect(checks).toBe(1); expect(asks).toBe(0);
    await createExecutor(options).run(def, session);
    expect(await session.events.readOrdered()).toHaveLength(completed.length);
  });

  it.each([undefined, false])("旧节点require_readonly_mapping=%s缺执行器保持可见跳过", async requirement => {
    const def = workflow(); const node = def.spec.nodes[0]!;
    if (requirement === undefined) delete node.run!.require_readonly_mapping; else node.run!.require_readonly_mapping = false;
    await createExecutor({ humanGate: { async ask() { throw new Error("不应询问"); } } }).run(def, session);
    const completed = (await session.events.readOrdered()).find(event => event.type === "workflow.node.exited");
    expect(completed?.payload["notes"]).toContain("节点声明了 run 执行体但未注入 NodeRunner，执行被跳过（fail-visible）");
  });

  it("发布拒绝可写组合与错误类型，缺省不新增字段或改变旧输入身份", async () => {
    const def = workflow(); const node = def.spec.nodes[0]!;
    expect(WorkflowDefSchema.safeParse({ ...def, spec: { nodes: [{ ...node, run: { ...node.run, readonly: false } }] } }).success).toBe(false);
    expect(WorkflowDefSchema.safeParse({ ...def, spec: { nodes: [{ ...node, run: { ...node.run, require_readonly_mapping: "true" } }] } }).success).toBe(false);
    delete node.run!.require_readonly_mapping;
    const parsed = WorkflowDefSchema.parse(def); expect(parsed.spec.nodes[0]!.run).not.toHaveProperty("require_readonly_mapping");
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    expect(coordinationInputHash(parsed, snapshot, "a".repeat(64))).toBe(coordinationInputHash(def, snapshot, "a".repeat(64)));
    const required = workflow(); expect(coordinationInputHash(required, snapshot, "a".repeat(64))).not.toBe(coordinationInputHash(def, snapshot, "a".repeat(64)));
  });

  it.each(["missing_hook", "missing_capabilities", "unmapped", "acp", "unavailable", "missing_identity"])("协调%s不能advance，wait仍可解释约束", async mode => {
    const def = workflow(); const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    const agents: CoordinationAgents | undefined = mode === "missing_hook" ? undefined : [{ agent: "worker", resolution: mode === "unavailable" ? "unavailable" : "resolved",
      configuration_hash: mode === "missing_identity" || mode === "unavailable" ? null : "a".repeat(64), capabilities: mode === "missing_capabilities" || mode === "unavailable" ? null
        : { ...caps, ...(mode === "unmapped" ? { readonly_launch: "unmapped" } : {}), ...(mode === "acp" ? { transport: "acp" } : {}) } }];
    expect(buildCoordinationPrompt(def, snapshot, undefined, null, [], undefined, undefined, agents)).toContain("eligible_nodes: []");
    expect(() => parseCoordinationProposal(JSON.stringify(advance), def, snapshot, [], undefined, undefined, agents)).toThrow(/不可推进/);
    const waiting = { ...advance, next_action: { kind: "wait", reason: "修复只读映射", evidence: [{ source: "workflow", id: "review" }] } };
    expect(parseCoordinationProposal(JSON.stringify(waiting), def, snapshot, [], undefined, undefined, agents)).toEqual(waiting);
  });

  it("明确headless映射可推进；未启用要求的旧readonly节点保持兼容", async () => {
    const def = workflow(); const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    const agents: CoordinationAgents = [{ agent: "worker", resolution: "resolved", configuration_hash: "a".repeat(64), capabilities: caps }];
    expect(buildCoordinationPrompt(def, snapshot, undefined, null, [], undefined, undefined, agents)).toContain('eligible_nodes: ["review"]');
    expect(parseCoordinationProposal(JSON.stringify(advance), def, snapshot, [], undefined, undefined, agents)).toEqual(advance);
    delete def.spec.nodes[0]!.run!.require_readonly_mapping;
    expect(parseCoordinationProposal(JSON.stringify(advance), def, snapshot)).toEqual(advance);
  });

  it.each([undefined, { ...caps, readonly_launch: "unmapped" as const }, { ...caps, transport: "acp" as const }])("派发缺能力不调用driver、不重试或代写", async capabilities => {
    let calls = 0; const def = workflow(); const node = def.spec.nodes[0]!;
    const driver: AgentDriver = { name: "worker", ...(capabilities === undefined ? {} : { capabilities }), configuration_hash: "a".repeat(64),
      async *run() { calls++; yield { type: "result", data: { text: "不应派发", session_id: null } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver });
    expect(await runner.runNode(node, session, { workflow_id: def.metadata.id, node_id: node.id })).toMatchObject({ status: "failed", retryable: false });
    expect(calls).toBe(0); const events = await session.events.readOrdered();
    expect(events.filter(event => event.type === "agent.task.started")).toHaveLength(1);
    expect(events.find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "configuration", retryable: false });
    await expect(readFile(join(session.dir, "review.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("实际子进程缺映射不启动，配置修复后readonly=true参数与报告写回生效", async () => {
    const def = workflow(); const node = def.spec.nodes[0]!; const pid = join(root, "worker.pid");
    const args = [fixture, "--mode", "claude", "--no-tools", "--pid-file", pid, "--result-text", "# 只读报告\nLATEST_READONLY_INPUT", "{{prompt}}"];
    const unmapped = new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, args) });
    const ctx = { workflow_id: def.metadata.id, node_id: node.id, run_id: ulid() };
    expect((await createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => unmapped }).runNode(node, session, ctx)).status).toBe("failed");
    await expect(readFile(pid)).rejects.toMatchObject({ code: "ENOENT" });
    const mapped = new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, [...args, "--readonly", "{{readonly}}"]) });
    const actual: string[][] = []; const run = mapped.run.bind(mapped);
    mapped.run = async function* (task) { for await (const event of run(task)) {
      const argv = (event.data as { raw?: { argv?: string[] } }).raw?.argv; if (Array.isArray(argv)) actual.push(argv); yield event;
    } };
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => mapped });
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    expect(actual.some(argv => argv[argv.indexOf("--readonly") + 1] === "true" && argv.some(value => value.includes("LATEST_READONLY_INPUT")))).toBe(true);
    expect(await readFile(pid, "utf8")).toMatch(/^\d+$/);
    expect(await readFile(join(session.dir, "review.md"), "utf8")).toContain("LATEST_READONLY_INPUT");
    const completion = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed").at(-1)!;
    expect(completion.payload).toMatchObject({ status: "ok", written_by: "coordinator", artifact_written: true });
    expect(await runner.isCompletionReusable!(node, session, ctx, completion)).toBe(true);
  });

  it("外部driver能力漂移即使hash不变也不复用；恢复同一映射后重新核验可复用", async () => {
    const def = workflow(); const node = def.spec.nodes[0]!; const capabilities = { ...caps };
    const driver: AgentDriver = { name: "worker", configuration_hash: "a".repeat(64), capabilities,
      async *run() { yield { type: "result", data: { text: "# 当前只读报告", session_id: null } }; }, async *resume() {} };
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => driver });
    const ctx = { workflow_id: def.metadata.id, node_id: node.id };
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    const completion = (await session.events.readOrdered()).find(event => event.type === "agent.task.completed")!;
    expect(await runner.isCompletionReusable!(node, session, ctx, completion)).toBe(true);
    capabilities.readonly_launch = "unmapped"; expect(await runner.isCompletionReusable!(node, session, ctx, completion)).toBe(false);
    capabilities.readonly_launch = "mapped"; expect(await runner.isCompletionReusable!(node, session, ctx, completion)).toBe(true);
  });
});
