/** 协调必须区分活动 run、任务启动事实和失败，完成前重新核验。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSession, type AgentDriver, type AgentTask, type SessionHandle, type WorkflowDef } from "../../src/index.js";
import { buildCoordinationPrompt, createContextSessionAgent, parseCoordinationProposal } from "../../src/coordinator/session-agent.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";

const run_id = ulid();
const task_event_id = ulid();
const execution = { run: { run_id, status: "failed", active: false }, tasks: [{ node_id: "plan", run_id, event_id: task_event_id,
  status: "failed", attempt: 2, max_attempts: 2, failure_stage: "driver", retryable: true }] };
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "execution" }, spec: {
  nodes: [{ id: "plan", depends_on: [], gates: [], run: { agent: "worker", readonly: true } }],
} };
const wait = { summary: "当前 worker 失败，等待补充事实", next_action: { kind: "wait", reason: "已失败两次",
  evidence: [{ source: "workflow", id: "plan" }] }, risks: [] };
let root: string;
let session: SessionHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-coordination-execution-"));
  session = await initSession(join(root, "cord"), "REQ-EXECUTION");
  await writeFile(join(session.dir, "prd.md"), "# PRD\n协调当前失败");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function driver(output = wait): AgentDriver & { tasks: AgentTask[] } {
  const tasks: AgentTask[] = [];
  return { name: "offline", configuration_hash: "a".repeat(64), tasks,
    async *run(task) { tasks.push(task); yield { type: "result", data: { text: JSON.stringify(output) } }; }, async *resume() {} };
}
function observer(worker: AgentDriver, read = async () => execution) {
  return createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_execution_context: read } as any);
}
const coordinate = (agent: ReturnType<typeof observer>) => agent.coordinate(def, session, { round_id: ulid(), agent: "offline" });

describe("协调执行上下文", () => {
  it("失败状态进入 prompt 和摘要，来源可引用当前任务，但没有 workflow 副作用", async () => {
    const proposal = { ...wait, next_action: { ...wait.next_action, evidence: [{ source: "agent_task", id: task_event_id }] } };
    const worker = driver(proposal as any);
    expect(await coordinate(observer(worker))).toMatchObject({ status: "ok", proposal });
    expect(worker.tasks[0]?.prompt).toContain(`execution_context: ${JSON.stringify(execution)}`);
    const events = await session.events.readOrdered();
    expect(events.find((event) => event.type === "coordinator.round.completed")?.payload["execution_context_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(events.some((event) => event.type.startsWith("workflow.") || event.type.startsWith("agent.task."))).toBe(false);
  });

  it("仅任务终态在途改变使提议 stale，下一轮看到最新失败且可恢复", async () => {
    let reads = 0;
    const started = { ...execution, run: { ...execution.run, status: "running", active: true }, tasks: [{ ...execution.tasks[0], status: "started", failure_stage: null, retryable: null }] };
    const worker = driver();
    const agent = observer(worker, async () => ++reads === 1 ? started : execution);
    expect(await coordinate(agent)).toMatchObject({ status: "stale", proposal: null });
    expect((await coordinate(agent)).status).toBe("ok");
    expect(worker.tasks[1]?.prompt).toContain('"status":"failed"');
  });

  it("活动 run 不允许 advance；started 且 inactive 不能被冒称活动进程", async () => {
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    const advance = { ...wait, next_action: { ...wait.next_action, kind: "advance", node_id: "plan" } };
    const active = { ...execution, run: { ...execution.run, status: "running", active: true } };
    expect(() => (parseCoordinationProposal as any)(JSON.stringify(advance), def, snapshot, [], active)).toThrow(/不可推进/);
    expect((buildCoordinationPrompt as any)(def, snapshot, undefined, null, [], active)).toContain("eligible_nodes: []");
    const inactive = { ...active, run: { ...active.run, active: false }, tasks: [{ ...execution.tasks[0], status: "started", failure_stage: null, retryable: null }] };
    expect((parseCoordinationProposal as any)(JSON.stringify(advance), def, snapshot, [], inactive)).toMatchObject({ next_action: { kind: "advance" } });
  });

  it.each(["logs", "undeclared", "duplicate", "foreign-run", "too-many", "unreadable"])("非法宿主执行观察 %s 不派发 driver", async (kind) => {
    const worker = driver();
    const agent = observer(worker, async () => {
      if (kind === "unreadable") throw new Error("执行观察不可读");
      if (kind === "logs") return { ...execution, tasks: [{ ...execution.tasks[0], error: "PRIVATE_LOG" }] };
      if (kind === "undeclared") return { ...execution, tasks: [{ ...execution.tasks[0], node_id: "unknown" }] };
      if (kind === "duplicate") return { ...execution, tasks: [execution.tasks[0], execution.tasks[0]] };
      if (kind === "foreign-run") return { ...execution, tasks: [{ ...execution.tasks[0], run_id: ulid() }] };
      return { ...execution, tasks: Array.from({ length: 129 }, (_, index) => ({ ...execution.tasks[0], node_id: `node-${index}` })) };
    });
    expect(await coordinate(agent)).toMatchObject({ status: "failed", proposal: null });
    expect(worker.tasks).toHaveLength(0);
    expect(JSON.stringify(await session.events.readOrdered())).not.toContain("PRIVATE_LOG");
  });

  it.each(["unknown", "invalid", "missing", "old"])("%s 任务事件不能冒充当前合法来源", async (kind) => {
    const output = { ...wait, next_action: { ...wait.next_action, evidence: [{ source: "agent_task", id: kind === "unknown" || kind === "old" ? ulid() : task_event_id }] } };
    const context = { ...execution, tasks: [{ ...execution.tasks[0], ...(kind === "invalid" ? { status: "invalid", attempt: null, max_attempts: null, failure_stage: null, retryable: null } : {}),
      ...(kind === "missing" ? { status: "missing", event_id: null, attempt: null, max_attempts: null, failure_stage: null, retryable: null } : {}) }] };
    expect(await coordinate(observer(driver(output as any), async () => context as any))).toMatchObject({ status: "failed", proposal: null });
  });

  it("观察重检失败或取消不能返回旧提议，未绑定 hook 保持库模式", async () => {
    let reads = 0;
    const worker = driver();
    expect(await coordinate(observer(worker, async () => { if (++reads > 1) throw new Error("执行重检不可读"); return execution; }))).toMatchObject({ status: "failed", proposal: null });
    const controller = new AbortController(); reads = 0;
    const bound = observer(worker, async () => { if (++reads > 1) controller.abort(); return execution; });
    expect(await bound.coordinate(def, session, { round_id: ulid(), agent: "offline", signal: controller.signal })).toMatchObject({ status: "cancelled", proposal: null });
    const legacy = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root });
    expect((await coordinate(legacy)).status).toBe("ok");
    expect(worker.tasks.at(-1)?.prompt).not.toContain("execution_context:");
  });
});
