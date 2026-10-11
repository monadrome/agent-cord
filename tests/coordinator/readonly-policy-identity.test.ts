import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { AcpDriver, createNodeRunner, createExecutor, initSession, type AgentDriver, type SessionHandle, type WorkflowDef } from "../../src/index.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";
import { executionInputHash, readApprovalContextHash } from "../../src/coordinator/checkpoint.js";
import { coordinationInputHash } from "../../src/coordinator/session-agent.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { readCoordinationSnapshot } from "../../src/coordinator/coordination-context.js";

let root: string; let session: SessionHandle;
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "policy-identity" }, spec: { nodes: [
  { id: "review", artifact: "review.md", depends_on: [], run: { agent: "worker", readonly: true, output: "text", retry: { max_attempts: 3, backoff_ms: 0 } }, gates: [
    { id: "human", role: { initiators: [], approvers: [] }, attach: { node: "review", when: "post", triggers: [] },
      checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block", write_back: [] },
  ] },
] } };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-readonly-policy-")); session = await initSession(join(root, "cord"), "REQ-POLICY"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("只读审计策略证明身份", () => {
  it.each([{ argv: ["rg", "--pre", "PRIVATE_EXEC", "pattern"] }, { argv: ["git", "diff", "--output=PRIVATE_OUTPUT"] }])("真实ACP工具输入%j同样不可重试，修复为结构化读参数可恢复", async unsafe => {
    const fixture = fileURLToPath(new URL("../driver/fixtures/fake-acp-agent.mjs", import.meta.url));
    const create = (input: unknown) => new AcpDriver({ bin: process.execPath, args: [fixture, "--no-tools", "--result-text", "# 完整评审", "--emit-command", JSON.stringify(input)] });
    const node = def.spec.nodes[0]!; const ctx = { workflow_id: def.metadata.id, node_id: node.id };
    await writeFile(join(session.dir, "review.md"), "# 人工原稿");
    expect(await createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => create(unsafe) }).runNode(node, session, ctx)).toMatchObject({ status: "failed" });
    const completed = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed");
    expect(completed).toHaveLength(1); expect(completed[0]!.payload).toMatchObject({ failure_stage: "driver", retryable: false });
    expect(JSON.stringify(completed)).not.toContain("PRIVATE"); expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe("# 人工原稿");
    expect(await createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => create({ argv: ["rg", "--fixed-strings", "pattern with space", "src"] }) }).runNode(node, session, ctx)).toMatchObject({ status: "ok" });
    expect(await readFile(join(session.dir, "review.md"), "utf8")).toContain("完整评审");
  });
  it.each([false, true])("readonly=%s执行/审批/协调仅在只读流程改变旧identity", async readonly => {
    const workflow = structuredClone(def); const node = workflow.spec.nodes[0]!; node.run!.readonly = readonly;
    const snapshot = await readSnapshot(session, { workflow_id: workflow.metadata.id, files: ["review.md"], excerpt_mode: "head_tail" });
    const legacy_execution = sha256Hex(canonicalJson({ domain: "cord.execution-input.v4", context_policy: "worker-balanced-head-tail.v1", agent_configuration_hash: "a".repeat(64),
      workflow, node, req_id: snapshot.req_id, title: snapshot.title, max_pack_chars: 60000,
      docs: snapshot.docs.filter(doc => doc.file !== node.artifact).map(({ file, exists, content_hash }) => ({ file, exists, content_hash })), ledger: snapshot.ledger, exited: [] }));
    const current_execution = executionInputHash(workflow, node, snapshot, 60000, "a".repeat(64));
    expect(current_execution === legacy_execution).toBe(!readonly);
    const legacy_approval = sha256Hex(canonicalJson({ domain: "cord.approval-context.v1", workflow, node, agent_configuration_hash: "a".repeat(64), req_id: snapshot.req_id, title: snapshot.title,
      docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })), ledger: snapshot.ledger }));
    expect((await readApprovalContextHash(workflow, node, session, "a".repeat(64))) === legacy_approval).toBe(!readonly);
    const coordination_snapshot = await readCoordinationSnapshot(workflow, session);
    const legacy_coordination = sha256Hex(canonicalJson({ domain: "cord.coordination-input.v5", context_policy: "balanced-head-tail.v1", tool_policy: "none.v1", workflow,
      configuration_hash: "a".repeat(64), max_prompt_chars: 60000, req_id: coordination_snapshot.req_id, title: coordination_snapshot.title,
      docs: coordination_snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })), ledger: coordination_snapshot.ledger,
      workflow_progress: { ...coordination_snapshot.workflow, waiting: coordination_snapshot.workflow.waiting ?? [] } }));
    expect(coordinationInputHash(workflow, coordination_snapshot, "a".repeat(64)) === legacy_coordination).toBe(!readonly);
  });

  it("旧readonly成功checkpoint重做，新策略结果可复用，危险工具失败不重试/不覆写原稿", async () => {
    let calls = 0; let unsafe = false;
    const worker: AgentDriver = { name: "worker", configuration_hash: "a".repeat(64), async *run() { calls++;
      yield { type: "tool_use", data: { name: "command_execution", input: unsafe ? { command: "git diff --output=PRIVATE_OUTPUT" } : { argv: ["rg", "--fixed-strings", "pattern with spaces", "src"] } } };
      yield { type: "result", data: { text: "# 当前评审\n保留人工终审。" } };
    }, async *resume() {} };
    const node = def.spec.nodes[0]!; const ctx = { workflow_id: def.metadata.id, node_id: node.id };
    const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => worker });
    const human = { ask: async (): Promise<string> => { throw new Error("人审未决"); } };
    await expect(createExecutor({ nodeRunner: runner, humanGate: human }).run(def, session)).rejects.toThrow("人审未决");
    const original = (await session.events.readOrdered()).find(event => event.type === "agent.task.completed")!;
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id, files: ["review.md"], excerpt_mode: "head_tail" });
    const old_hash = sha256Hex(canonicalJson({ domain: "cord.execution-input.v4", context_policy: "worker-balanced-head-tail.v1", agent_configuration_hash: worker.configuration_hash,
      workflow: def, node, req_id: snapshot.req_id, title: snapshot.title, max_pack_chars: 60000,
      docs: snapshot.docs.filter(doc => doc.file !== node.artifact).map(({ file, exists, content_hash }) => ({ file, exists, content_hash })), ledger: snapshot.ledger, exited: [] }));
    const old = await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.completed", schema_version: "1", actor: original.actor,
      correlation_id: node.id, source: original.source, payload: { ...original.payload, execution_input_hash: old_hash } });
    expect(await runner.isCompletionReusable!(node, session, ctx, old)).toBe(false);
    await expect(createExecutor({ nodeRunner: runner, humanGate: human }).run(def, session)).rejects.toThrow("人审未决"); expect(calls).toBe(2);
    await expect(createExecutor({ nodeRunner: runner, humanGate: human }).run(def, session)).rejects.toThrow("人审未决"); expect(calls).toBe(2);
    const prior = await readFile(join(session.dir, "review.md"), "utf8"); unsafe = true;
    expect(await runner.runNode(node, session, ctx)).toMatchObject({ status: "failed" }); expect(calls).toBe(3);
    expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe(prior);
    const failed = (await session.events.readOrdered()).filter(event => event.type === "agent.task.completed").at(-1)!;
    expect(failed.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false }); expect(JSON.stringify(failed)).not.toContain("PRIVATE_OUTPUT");
    expect((await session.events.readOrdered()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
