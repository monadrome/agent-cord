/** 执行版本指纹、无版本兼容模式与 scoped 快照/事件 checker。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { initSession } from "../../src/core/session.js";
import type { SessionHandle } from "../../src/core/ports.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { workflowRevision, matchesWorkflowScope } from "../../src/workflow/scope.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { createEventEmittedChecker } from "../../src/workflow/checkers.js";

const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "shared" }, spec: { nodes: [{ id: "review", depends_on: [], gates: [] }] } };
const first = workflowRevision(def, { id: "published", version: 1 });
const second = workflowRevision(def, { id: "published", version: 2 });
let root: string | undefined;
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined; });
async function session() { root = await mkdtemp(join(tmpdir(), "cord-scope-")); return initSession(join(root, "cord"), "REQ-SCOPE"); }
async function append(handle: SessionHandle, type: string, payload: Record<string, unknown>) {
  return handle.events.append({ event_id: ulid(), session_id: handle.req_id, type, schema_version: "1", actor: { kind: "system", id: "test" }, correlation_id: "review", payload, source: { adapter: "test" } });
}

describe("执行作用域", () => {
  it("完整定义和发布绑定决定稳定身份，字段顺序不影响指纹", () => {
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowRevision({ spec: def.spec, metadata: def.metadata, kind: def.kind, apiVersion: def.apiVersion }, { version: 1, id: "published" })).toBe(first);
    expect(second).not.toBe(first);
    expect(workflowRevision(def, { id: "other", version: 1 })).not.toBe(first);
    expect(workflowRevision({ ...def, metadata: { ...def.metadata, name: "更新定义" } }, { id: "published", version: 1 })).not.toBe(first);
  });

  it("显式作用域不接受其他版本/ID/无版本事件，兼容模式不继承带版本事实", () => {
    const scope = { workflow_id: "shared", workflow_revision: first };
    expect(matchesWorkflowScope({ ...scope, node_id: "review" }, scope)).toBe(true);
    for (const payload of [null, [], { workflow_id: "shared" }, { workflow_id: "shared", workflow_revision: second }, { workflow_id: "other", workflow_revision: first }]) expect(matchesWorkflowScope(payload, scope)).toBe(false);
    expect(matchesWorkflowScope({ workflow_id: "shared" }, { workflow_id: "shared" })).toBe(true);
    expect(matchesWorkflowScope(scope, { workflow_id: "shared" })).toBe(false);
  });

  it("快照按版本读取退出与等待，取消只影响对应版本，事件 provenance 仍覆盖全流", async () => {
    const handle = await session();
    await append(handle, "workflow.node.exited", { workflow_id: "shared", workflow_revision: first, node_id: "review" });
    await append(handle, "gate.waiting", { workflow_id: "shared", workflow_revision: first, node_id: "review", gate_id: "human" });
    const pending = await append(handle, "gate.waiting", { workflow_id: "shared", workflow_revision: second, node_id: "review", gate_id: "human" });
    await append(handle, "workflow.run.cancelled", { workflow_id: "shared", workflow_revision: first, run_id: "cancel-first" });
    const snapshot = await readSnapshot(handle, { workflow_id: "shared", workflow_revision: second });
    expect(snapshot.workflow.exited).toEqual([]);
    expect(snapshot.workflow.waiting).toEqual([{ node_id: "review", gate_id: "human", waiting_event_id: pending.event_id }]);
    expect(snapshot.workflow_revision).toBe(second);
    expect(snapshot.event_seq).toBe(4);
    expect((await readSnapshot(handle, { workflow_id: "shared", workflow_revision: first })).workflow.exited).toEqual(["review"]);
    expect((await readSnapshot(handle, { workflow_id: "shared" })).workflow.exited).toEqual([]);
    await expect(readSnapshot(handle, { workflow_revision: first })).rejects.toThrow(/workflow_id/);
  });

  it("事件 gate 不接受旧版本的任务完成，但共享账本事件仍可使用", async () => {
    const handle = await session();
    await append(handle, "agent.task.completed", { workflow_id: "shared", workflow_revision: first, node_id: "review", driver: "test", status: "ok" });
    await append(handle, "ledger.entry.confirmed", { entry_id: "C-1" });
    const checker = createEventEmittedChecker();
    const ctx = { session_dir: handle.dir, session: handle, workflow_id: "shared", workflow_revision: second, node_id: "review", anchors: [], payload: {}, params: { type: "agent.task.completed" } };
    expect((await checker.check(ctx)).result).toBe("block");
    expect((await checker.check({ ...ctx, params: { type: "ledger.entry.confirmed" } })).result).toBe("pass");
    await append(handle, "agent.task.completed", { workflow_id: "shared", workflow_revision: second, node_id: "review", driver: "test", status: "ok" });
    expect((await checker.check(ctx)).result).toBe("pass");
  });
});
