/** 当前 run 的受限 worker 观察；不猜测旧任务归属或进程存活。 */
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSession, parseWorkflow, type SessionHandle } from "agent-cord";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";
import type { RunService } from "../src/services/run-service.js";

let root: string;
let session: SessionHandle;
const run_id = ulid();
const revision = "a".repeat(64);
const def = parseWorkflow(YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "tasks" }, spec: {
  nodes: [{ id: "intake" }, { id: "review", depends_on: ["intake"], run: { agent: "worker", readonly: true } }],
} }));
const run = { run_id, req_id: "REQ-TASKS", workflow_revision: revision, status: "running" };
const service = () => ({ latestRun: vi.fn(async () => run), activeRunId: vi.fn(() => run_id as string | null) });
const read = (runs = service()) => readCoordinationExecutionContext(def, session, revision, runs as unknown as RunService);
async function record(type = "agent.task.completed", overrides: Record<string, unknown> = {}, correlation_id = "review") {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "agent", id: "coordinator" }, correlation_id,
    payload: { workflow_id: def.metadata.id, workflow_revision: revision, run_id, node_id: "review", driver: "headless:worker", status: "failed", attempt: 2, max_attempts: 2,
      failure_stage: "driver", retryable: true, error: "PRIVATE_ERROR", text: "PRIVATE_REPORT", prompt_excerpt: "PRIVATE_PROMPT", ...overrides }, source: { adapter: "test" } });
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-worker-observation-")); session = await initSession(join(root, "cord"), "REQ-TASKS"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("worker 执行观察", () => {
  it("缺失/启动/失败/恢复状态可见，仅覆盖声明 worker 且不携带私有字段", async () => {
    expect(await read()).toMatchObject({ run: { run_id, status: "running", active: true }, tasks: [{ node_id: "review", status: "missing" }] });
    const started = await record("agent.task.started", { failure_stage: undefined, retryable: undefined });
    expect((await read()).tasks[0]).toMatchObject({ status: "started", event_id: started.event_id, failure_stage: null, retryable: null });
    const failed = await record();
    expect((await read()).tasks[0]).toMatchObject({ status: "failed", event_id: failed.event_id, attempt: 2, max_attempts: 2, failure_stage: "driver", retryable: true });
    const fixed = await record("agent.task.completed", { status: "ok", failure_stage: undefined, retryable: undefined });
    const result = await read();
    expect(result.tasks[0]).toMatchObject({ status: "ok", event_id: fixed.event_id });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("旧 run/发布版本、未声明节点和无 run_id 的旧任务不能冒充当前事实", async () => {
    await record("agent.task.completed", { run_id: ulid() });
    await record("agent.task.completed", { workflow_revision: "b".repeat(64) });
    await record("agent.task.completed", { node_id: "intake" });
    await record("agent.task.completed", { run_id: undefined });
    expect((await read()).tasks[0]?.status).toBe("missing");
    const runs = service();
    runs.latestRun.mockResolvedValueOnce({ ...run, workflow_revision: "c".repeat(64) });
    expect(await read(runs)).toMatchObject({ run: null, tasks: [{ run_id: null, status: "missing" }] });
  });

  it.each([{ status: "bogus" }, { driver: undefined }, { attempt: -1 }, { max_attempts: 1 }, { failure_stage: "unknown" }, { retryable: "yes" }, { status: "ok", failure_stage: "driver" }])("坏最新任务 %j 不回退历史成功，修复后恢复", async (value) => {
    await record("agent.task.completed", { status: "ok", failure_stage: undefined });
    const broken = await record("agent.task.completed", value);
    expect((await read()).tasks[0]).toMatchObject({ status: "invalid", event_id: broken.event_id, failure_stage: null, retryable: null });
    await record();
    expect((await read()).tasks[0]?.status).toBe("failed");
  });

  it("坏 correlation 的最新记录不被过滤掉，不能回退旧成功", async () => {
    await record("agent.task.completed", { status: "ok" });
    const broken = await record("agent.task.completed", {}, "foreign-node");
    expect((await read()).tasks[0]).toMatchObject({ status: "invalid", event_id: broken.event_id });
  });

  it("只有真实匹配槽位才 active，冷 started 不是正在运行的声明，终态忽略收尾槽位", async () => {
    await record("agent.task.started");
    const runs = service();
    runs.activeRunId.mockReturnValueOnce(null);
    expect(await read(runs)).toMatchObject({ run: { status: "running", active: false }, tasks: [{ status: "started" }] });
    runs.activeRunId.mockReturnValueOnce(ulid());
    expect((await read(runs)).run?.active).toBe(false);
    runs.latestRun.mockResolvedValueOnce({ ...run, status: "failed" });
    expect((await read(runs)).run).toMatchObject({ status: "failed", active: false });
  });

  it("事件读故障拒绝观察，不提供空的成功投影", async () => {
    await appendFile(join(session.dir, "events.jsonl"), "PRIVATE_BROKEN_TASK\n");
    await expect(read()).rejects.toThrow(/无法解析/);
  });
});
