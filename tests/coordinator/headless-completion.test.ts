import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { HeadlessDriver, initSession, createNodeRunner, createExecutor, type AgentDriver, type SessionHandle, type WorkflowDef } from "../../src/index.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const fixture = fileURLToPath(new URL("../driver/fixtures/fake-cli.mjs", import.meta.url));
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "process-completion" }, spec: { nodes: [
  { id: "draft", artifact: "review.md", depends_on: [], run: { agent: "worker", readonly: false }, gates: [
    { id: "human", role: { initiators: [], approvers: [] }, attach: { node: "draft", when: "post", triggers: [] },
      checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block", write_back: [] },
  ] },
] } };
let root: string; let session: SessionHandle;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-completion-host-")); session = await initSession(join(root, "cord"), "REQ-COMPLETION"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const driver = (flags: string[] = []) => new HeadlessDriver({ cli: "claude", bin: process.execPath, prefixArgs: [fixture, "--no-tools", "--result-text", "# 当前候选报告", ...flags] });
const runner = (agent: AgentDriver, workflow = def) => createNodeRunner(workflow, { resolveDriver: () => agent, workspaceRoot: root });

describe("宿主完整消费Headless进程事实", () => {
  it.each([false, true])("readonly=%s晚退出失败保留人工原稿，不落ok或可复用完成", async readonly => {
    const workflow = structuredClone(def); workflow.spec.nodes[0]!.run!.readonly = readonly;
    if (readonly) workflow.spec.nodes[0]!.run!.output = "text";
    const original = "# 人工原稿\n尚未完成本次评审。\n"; await writeFile(join(session.dir, "review.md"), original);
    const node = workflow.spec.nodes[0]!; const ctx = { workflow_id: workflow.metadata.id, node_id: node.id };
    const node_runner = runner(driver(["--exit-code", "3"]), workflow);
    expect(await node_runner.runNode(node, session, ctx)).toMatchObject({ status: "failed" });
    expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe(original);
    const completed = (await session.events.readOrdered()).find(event => event.type === "agent.task.completed")!;
    expect(completed.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: true });
    expect(completed.payload["artifact_written"] ?? false).toBe(false); expect(completed.payload["written_by"] ?? "none").toBe("none");
    expect(completed.payload["text"]).toContain("当前候选报告");
    expect(await node_runner.isCompletionReusable!(node, session, ctx, completed)).toBe(false);
  });

  it("旧启动身份的完整未退出checkpoint重跑，新策略完成随后可复用而不重复worker", async () => {
    const agent = driver(); const calls = vi.spyOn(agent, "run"); const task = { prompt: "cord.configuration.prompt", cwd: "" };
    const legacy_hash = sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v1", name: agent.name,
      argv: agent.buildArgv(task), readonly_argv: agent.buildArgv({ ...task, readonly: true }), resume_argv: agent.buildArgv(task, "cord.configuration.session"),
      readonly_resume_argv: agent.buildArgv({ ...task, readonly: true }, "cord.configuration.session") }));
    const legacy: AgentDriver = { name: agent.name, capabilities: agent.capabilities, configuration_hash: legacy_hash,
      run: task => agent.run(task), resume: (id, task) => agent.resume(id, task) };
    const human = { ask: async (): Promise<string> => { throw new Error("保留人工等待"); } };
    await expect(createExecutor({ nodeRunner: runner(legacy), humanGate: human, run_id: ulid() }).run(def, session)).rejects.toThrow("保留人工等待");
    const old = (await session.events.readOrdered()).find(event => event.type === "agent.task.completed")!;
    expect(old.payload).toMatchObject({ status: "ok", agent_configuration_hash: legacy_hash });
    const current = runner(agent); const node = def.spec.nodes[0]!;
    expect(await current.isCompletionReusable!(node, session, { workflow_id: def.metadata.id, node_id: node.id }, old)).toBe(false);
    await expect(createExecutor({ nodeRunner: current, humanGate: human, run_id: ulid() }).run(def, session)).rejects.toThrow("保留人工等待");
    expect(calls.mock.calls.length).toBe(2);
    const completions = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed");
    expect(completions).toHaveLength(2); expect(completions[1]!.payload["agent_configuration_hash"]).toBe(agent.configuration_hash);
    await expect(createExecutor({ nodeRunner: current, humanGate: human, run_id: ulid() }).run(def, session)).rejects.toThrow("保留人工等待");
    expect(calls.mock.calls.length).toBe(2);
    expect((await session.events.readOrdered()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
