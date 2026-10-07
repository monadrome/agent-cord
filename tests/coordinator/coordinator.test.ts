/**
 * 协调 agent 测试（ADR-0023）：快照/上下文包/事件落盘/artifact 双通道写回/恢复不重复执行。
 * driver 用内存 fake（不 spawn 子进程）；session 用真实 initSession（tmpdir）。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { ulid } from "ulid";
import { sha256Hex } from "../../src/core/hash.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDriver, AgentEvent, SessionHandle } from "../../src/core/ports.js";
import { initSession } from "../../src/core/session.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { buildContextPack } from "../../src/coordinator/context-pack.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { createExecutor } from "../../src/workflow/executor.js";

let root: string;
let cordRoot: string;
let session: SessionHandle;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-coord-"));
  cordRoot = join(root, "cord");
  session = await initSession(cordRoot, "REQ-1");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fake driver
// ---------------------------------------------------------------------------

function fakeDriver(events: AgentEvent[]): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    prompts,
    async *run(task) {
      prompts.push(task.prompt);
      for (const event of events) yield event;
    },
    async *resume() {
      // 测试不需要 resume
    },
  };
}

function okDriver(text: string): ReturnType<typeof fakeDriver> {
  return fakeDriver([
    { type: "text", data: { text } },
    { type: "result", data: { text, session_id: "agent-sess-1" } },
  ]);
}

function okDriverWithUsage(text: string): ReturnType<typeof fakeDriver> {
  return fakeDriver([
    {
      type: "result",
      data: {
        text,
        session_id: "agent-sess-1",
        usage: { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 800, cost_usd: 0.0042 },
      },
    },
  ]);
}

/** 前 failures 次派发出错、之后成功的 stateful fake（重试测试用） */
function flakyDriver(failures: number, okText: string): AgentDriver & { prompts: string[]; calls: () => number } {
  const prompts: string[] = [];
  let calls = 0;
  return {
    name: "flaky",
    prompts,
    calls: () => calls,
    async *run(task) {
      calls++;
      prompts.push(task.prompt);
      if (calls <= failures) {
        yield {
          type: "error",
          data: { message: `boom-${calls}`, kind: "agent" },
        } satisfies AgentEvent;
      } else {
        yield { type: "result", data: { text: okText, session_id: "s-retry" } } satisfies AgentEvent;
      }
    },
    async *resume() {},
  };
}

/** 带重试策略的流程定义（plan 节点 retry 3 次、无退避） */
const DEF_RETRY: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "wf-retry" },
  spec: {
    nodes: [
      { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
      {
        id: "plan",
        artifact: "plan.md",
        depends_on: ["intake"],
        run: { agent: "fake-agent", readonly: false, retry: { max_attempts: 3, backoff_ms: 0 } },
        gates: [],
      },
      { id: "done", depends_on: ["plan"], gates: [] },
    ],
  },
};

const DEF: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "wf-agent" },
  spec: {
    nodes: [
      { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
      {
        id: "plan",
        artifact: "plan.md",
        depends_on: ["intake"],
        run: { agent: "fake-agent", readonly: false },
        gates: [],
      },
      { id: "done", depends_on: ["plan"], gates: [] },
    ],
  },
};

function asPayload(event: { payload: unknown }): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// coordinator（NodeRunner）
// ---------------------------------------------------------------------------

describe("coordinator（NodeRunner）", () => {
  it("只有协议或思考辅助文本时不能生成 artifact，保留原文", async () => {
    const old = "# ORIGINAL_ARTIFACT";
    await writeFile(join(session.dir, "plan.md"), old);
    const driver = fakeDriver([
      { type: "text", data: { text: "PROTOCOL_METADATA", channel: "metadata" } },
      { type: "text", data: { text: "THOUGHT_METADATA", channel: "metadata" } },
      { type: "result", data: { text: null } },
    ]);
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toBe(old);
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!).text).toBe("");
  });

  it("无显式最终文本时只回退内容通道，不混入协议辅助文本", async () => {
    const driver = fakeDriver([
      { type: "text", data: { text: "PROTOCOL_METADATA", channel: "metadata" } },
      { type: "text", data: { text: "# ACTUAL_CONTENT" } },
      { type: "result", data: { text: null } },
    ]);
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    const updated = await readFile(join(session.dir, "plan.md"), "utf8");
    expect(updated).toContain("ACTUAL_CONTENT");
    expect(updated).not.toContain("PROTOCOL_METADATA");
  });

  it("执行前已有旧 artifact，worker 返回新文本时代写最新 draft，不误记 agent 自写", async () => {
    const old = "# 旧计划\nOLDER_CONTENT\n";
    await writeFile(join(session.dir, "plan.md"), old);
    const runner = createNodeRunner(DEF, { resolveDriver: () => okDriver("# 新计划\nLATEST_CONTENT"), workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    const updated = await readFile(join(session.dir, "plan.md"), "utf8");
    expect(updated).toContain("LATEST_CONTENT");
    expect(updated).not.toContain("OLDER_CONTENT");
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!).written_by).toBe("coordinator");
    expect(asPayload(completed!).artifact_before_hash).toBe(sha256Hex(old));
    expect(asPayload(completed!).artifact_after_hash).toBe(sha256Hex(updated));
    expect(asPayload(completed!).artifact_changed).toBe(true);
  });

  it("旧文档未变化且 worker 无输出 → failed，保留旧文档，修复后可重新生成", async () => {
    const old = "# 既有文档\nOLD_ARTIFACT";
    await writeFile(join(session.dir, "plan.md"), old);
    const runner = createNodeRunner(DEF, { resolveDriver: () => fakeDriver([]), workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)).toMatchObject({ failure_stage: "artifact", retryable: false, artifact_written: false, written_by: "none", artifact_before_hash: sha256Hex(old), artifact_after_hash: sha256Hex(old), artifact_changed: false });
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toBe(old);
    const recovered = createNodeRunner(DEF, { resolveDriver: () => okDriver("# 恢复的新计划"), workspaceRoot: root });
    expect((await recovered.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toContain("恢复的新计划");
  });

  it("本次可写 artifact 无输出，占位文档不能让任务假成功", async () => {
    const runner = createNodeRunner(DEF, { resolveDriver: () => fakeDriver([]), workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toContain("占位文档");
  });

  it("readonly 声明 artifact 不要求生成，也不把原文记为写入", async () => {
    const old = "# REVIEW_SOURCE";
    await writeFile(join(session.dir, "plan.md"), old);
    const node = { ...DEF.spec.nodes[1]!, run: { agent: "fake-agent", readonly: true } };
    const runner = createNodeRunner(DEF, { resolveDriver: () => fakeDriver([]), workspaceRoot: root });
    expect((await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toBe(old);
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)).toMatchObject({ artifact_written: false, written_by: "none", artifact_changed: false, artifact_before_hash: sha256Hex(old), artifact_after_hash: sha256Hex(old) });
  });

  it("可写 artifact 无内容失败不消耗额外节点内重试", async () => {
    const driver = fakeDriver([]);
    const runner = createNodeRunner(DEF_RETRY, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF_RETRY.spec.nodes[1]!, session, { workflow_id: "wf-retry", node_id: "plan" })).status).toBe("failed");
    expect(driver.prompts).toHaveLength(1);
    const completed = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed");
    expect(completed).toHaveLength(1);
    expect(asPayload(completed[0]!).retryable).toBe(false);
  });

  it("node 参数的额外 artifact 也进入本次快照基线，不受 def 中旧文件名影响", async () => {
    const old = "# EXTRA_SOURCE";
    await writeFile(join(session.dir, "custom.md"), old);
    const node = { ...DEF.spec.nodes[1]!, artifact: "custom.md" };
    const runner = createNodeRunner(DEF, { resolveDriver: () => okDriver("# EXTRA_UPDATED"), workspaceRoot: root });
    expect((await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!).artifact_before_hash).toBe(sha256Hex(old));
    expect(await readFile(join(session.dir, "custom.md"), "utf8")).toContain("EXTRA_UPDATED");
  });

  it("观察到 worker 文件新内容时保留自写文件并记录完整指纹", async () => {
    const old = "# OLD";
    const updated = "# DIRECT_WORKER_OUTPUT";
    await writeFile(join(session.dir, "plan.md"), old);
    const driver = fakeDriver([]);
    driver.run = async function* () {
      await writeFile(join(session.dir, "plan.md"), updated);
      yield { type: "result", data: { text: "" } };
    };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("ok");
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)).toMatchObject({ written_by: "agent", artifact_before_hash: sha256Hex(old), artifact_after_hash: sha256Hex(updated), artifact_changed: true });
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toBe(updated);
  });

  it("执行期间 artifact 被删除后不盲目代写，记录观测到的冲突", async () => {
    const old = "# OLD_ARTIFACT";
    await writeFile(join(session.dir, "plan.md"), old);
    const driver = fakeDriver([]);
    driver.run = async function* () {
      await rm(join(session.dir, "plan.md"));
      yield { type: "result", data: { text: "不应覆盖删除操作" } };
    };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    await expect(readFile(join(session.dir, "plan.md"), "utf8")).rejects.toThrow();
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)).toMatchObject({ artifact_before_hash: sha256Hex(old), artifact_after_hash: null, artifact_changed: true, retryable: false });
  });

  it("第一次失败留下的部分产物不能冒充下一次成功产物", async () => {
    const driver = fakeDriver([]);
    let attempt = 0;
    driver.run = async function* (task) {
      driver.prompts.push(task.prompt);
      attempt += 1;
      if (attempt === 1) {
        await writeFile(join(session.dir, "plan.md"), "# PARTIAL_FAILED_OUTPUT");
        yield { type: "error", data: { kind: "agent", message: "transient worker failure" } };
      } else {
        yield { type: "result", data: { text: "# COMPLETE_NEW_OUTPUT" } };
      }
    };
    const runner = createNodeRunner(DEF_RETRY, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF_RETRY.spec.nodes[1]!, session, { workflow_id: "wf-retry", node_id: "plan" })).status).toBe("ok");
    const updated = await readFile(join(session.dir, "plan.md"), "utf8");
    expect(updated).toContain("COMPLETE_NEW_OUTPUT");
    expect(updated).not.toContain("PARTIAL_FAILED_OUTPUT");
  });

  it("快照读取失败落任务失败事件，不派发；输入修复后下一次可恢复", async () => {
    await rm(join(session.dir, "prd.md"));
    await mkdir(join(session.dir, "prd.md"));
    const driver = okDriver("# Plan\n修复后正常产出");
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    const ctx = { workflow_id: "wf-agent", node_id: "plan" };
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, ctx)).status).toBe("failed");
    expect(driver.prompts).toHaveLength(0);
    const failure = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(asPayload(failure!).failure_stage).toBe("snapshot");
    await rm(join(session.dir, "prd.md"), { recursive: true });
    await writeFile(join(session.dir, "prd.md"), "# PRD\n最新需求");
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, ctx)).status).toBe("ok");
    expect(driver.prompts[0]).toContain("最新需求");
  });

  it("瞬态快照读取故障按节点策略重试，成功后重新采集上下文", async () => {
    vi.spyOn(session.events, "readOrdered").mockRejectedValueOnce(new Error("transient event read IO"));
    const driver = okDriver("# 最新计划");
    const runner = createNodeRunner(DEF_RETRY, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF_RETRY.spec.nodes[1]!, session, { workflow_id: "wf-retry", node_id: "plan" })).status).toBe("ok");
    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toContain("transient event read IO");
    const completions = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed");
    expect(completions.map((event) => asPayload(event).status)).toEqual(["failed", "ok"]);
    expect(asPayload(completions[0]!).failure_stage).toBe("snapshot");
    expect(asPayload(completions[0]!).retryable).toBe(true);
  });

  it("快照准备期间取消，不启动 worker，不代写文档", async () => {
    const controller = new AbortController();
    const read = session.events.readOrdered.bind(session.events);
    vi.spyOn(session.events, "readOrdered").mockImplementationOnce(async () => {
      const events = await read();
      controller.abort();
      return events;
    });
    const driver = okDriver("不应派发");
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    const result = await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan", signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(driver.prompts).toHaveLength(0);
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toContain("占位文档");
  });

  it("driver 后写回失败落 completed，保持节点未退出；修复文件后恢复", async () => {
    const driver = okDriver("# Plan\n恢复计划");
    driver.run = async function* (task) {
      driver.prompts.push(task.prompt);
      await rm(join(session.dir, "plan.md"));
      await mkdir(join(session.dir, "plan.md"));
      yield { type: "result", data: { text: "计划", session_id: "s-failed-write" } };
    };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    const executor = createExecutor({ humanGate: { ask: async () => "确认放行" }, nodeRunner: runner });
    await expect(executor.run(DEF, session)).resolves.toBeUndefined();
    const events = await session.events.readOrdered();
    const failure = events.find((event) => event.type === "agent.task.completed");
    expect(asPayload(failure!).status).toBe("failed");
    expect(asPayload(failure!).failure_stage).toBe("artifact");
    expect(asPayload(failure!).agent_session_id).toBe("s-failed-write");
    expect(events.filter((event) => event.type === "workflow.node.exited").map((event) => asPayload(event).node_id)).toEqual(["intake"]);
    await rm(join(session.dir, "plan.md"), { recursive: true });
    const recovered_driver = okDriver("# 恢复计划");
    await createExecutor({
      humanGate: { ask: async () => "确认放行" },
      nodeRunner: createNodeRunner(DEF, { resolveDriver: () => recovered_driver, workspaceRoot: root }),
    }).run(DEF, session);
    expect((await session.events.readOrdered()).filter((event) => event.type === "workflow.node.exited")).toHaveLength(3);
  });

  it("驱动配置错误即使 retry=3 也只尝试一次", async () => {
    const resolve = vi.fn(() => { throw new Error("bad driver configuration"); });
    const runner = createNodeRunner(DEF_RETRY, { resolveDriver: resolve, workspaceRoot: root });
    expect((await runner.runNode(DEF_RETRY.spec.nodes[1]!, session, { workflow_id: "wf-retry", node_id: "plan" })).status).toBe("failed");
    expect(resolve).toHaveBeenCalledTimes(1);
    const completed = (await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed");
    expect(completed).toHaveLength(1);
    expect(asPayload(completed[0]!).retryable).toBe(false);
  });

  it.each(["events.jsonl", "ledger.yaml", "reports/../events.jsonl", ".index/result.md"])("事实/管理路径 %s 不能作为 artifact 派发", async (artifact) => {
    const driver = okDriver("不应执行");
    const node = { ...DEF.spec.nodes[1]!, artifact };
    const def = { ...DEF, spec: { nodes: [node] } };
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    expect(driver.prompts).toHaveLength(0);
    const events = await session.events.readOrdered();
    expect(events.map((event) => event.type)).toEqual(["agent.task.started", "agent.task.completed"]);
    expect(asPayload(events[1]!).retryable).toBe(false);
  });

  it("worker 结束后把 artifact 换成符号链接不能被归为成功", async () => {
    const outside = join(root, "external.md");
    await writeFile(outside, "OUTSIDE_CONTENT");
    const driver = okDriver("不应代写");
    driver.run = async function* () {
      await rm(join(session.dir, "plan.md"));
      await symlink(outside, join(session.dir, "plan.md"));
      yield { type: "result", data: { text: "不应代写" } };
    };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    expect((await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" })).status).toBe("failed");
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE_CONTENT");
  });

  it("追加 started 失败必须上抛且不派发，不能伪造 completed", async () => {
    const driver = okDriver("不应派发");
    const broken: SessionHandle = { ...session, events: {
      ...session.events,
      readOrdered: () => session.events.readOrdered(),
      readAll: () => session.events.readAll(),
      subscribe: (handler) => session.events.subscribe(handler),
      append: async () => { throw new Error("event storage unavailable"); },
    } };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    await expect(runner.runNode(DEF.spec.nodes[1]!, broken, { workflow_id: "wf-agent", node_id: "plan" })).rejects.toThrow("event storage unavailable");
    expect(driver.prompts).toHaveLength(0);
  });

  it("completed 无法追加时上抛，不能重试已经执行的 worker", async () => {
    const append = session.events.append.bind(session.events);
    vi.spyOn(session.events, "append").mockImplementation(async (draft) => {
      if (draft.type === "agent.task.completed") throw new Error("event fsync failure");
      return append(draft);
    });
    const driver = okDriver("# 首次执行");
    const runner = createNodeRunner(DEF_RETRY, { resolveDriver: () => driver, workspaceRoot: root });
    await expect(runner.runNode(DEF_RETRY.spec.nodes[1]!, session, { workflow_id: "wf-retry", node_id: "plan" })).rejects.toThrow("event fsync failure");
    expect(driver.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).map((event) => event.type)).toEqual(["agent.task.started"]);
  });

  it("流式任务结束后释放所有取消监听器", async () => {
    const driver = fakeDriver(Array.from({ length: 30 }, () => ({ type: "text", data: { text: "part" } })));
    const controller = new AbortController();
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan", signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("agent 只回文本 → coordinator 代写 artifact（written_by=coordinator）", async () => {
    const runner = createNodeRunner(DEF, {
      resolveDriver: () => okDriver("# Plan\n\n第一步：做 A。\n"),
      workspaceRoot: root,
    });
    const node = DEF.spec.nodes[1]!;
    const outcome = await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" });

    expect(outcome.status).toBe("ok");
    const written = await readFile(join(session.dir, "plan.md"), "utf8");
    expect(written).toContain("第一步：做 A。");
    expect(written).toContain("协调 agent 代写");

    const events = await session.events.readOrdered();
    const started = events.find((event) => event.type === "agent.task.started");
    const completed = events.find((event) => event.type === "agent.task.completed");
    expect(started).toBeDefined();
    expect(asPayload(started!)["snapshot_id"]).toMatch(/^[0-9a-f]{64}$/);
    expect(asPayload(started!)["snapshot_event_seq"]).toBe(asPayload(completed!)["snapshot_event_seq"]);
    expect(asPayload(started!)["snapshot_id"]).toBe(asPayload(completed!)["snapshot_id"]);
    expect(asPayload(completed!)["written_by"]).toBe("coordinator");
    expect(asPayload(completed!)["artifact_written"]).toBe(true);
    expect(asPayload(completed!)["agent_session_id"]).toBe("agent-sess-1");
    expect(completed!.actor).toEqual({ kind: "agent", id: "coordinator" });
    expect(completed!.correlation_id).toBe("plan");
  });

  it("result 事件带 usage → 落进 agent.task.completed 事件", async () => {
    const runner = createNodeRunner(DEF, {
      resolveDriver: () => okDriverWithUsage("# Plan\n\n第一步。\n"),
      workspaceRoot: root,
    });
    const node = DEF.spec.nodes[1]!;
    const outcome = await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" });
    expect(outcome.status).toBe("ok");

    const events = await session.events.readOrdered();
    const completed = events.find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)["usage"]).toEqual({
      input_tokens: 1200,
      output_tokens: 300,
      cached_input_tokens: 800,
      cost_usd: 0.0042,
    });
  });

  it("重试：前两次失败第三次成功 → 3 组 started/completed 带 attempt 编号，终态 ok", async () => {
    const driver = flakyDriver(2, "# Plan\n\n重试后产出。\n");
    const runner = createNodeRunner(DEF_RETRY, {
      resolveDriver: () => driver,
      workspaceRoot: root,
    });
    const node = DEF_RETRY.spec.nodes[1]!;
    const outcome = await runner.runNode(node, session, { workflow_id: "wf-retry", node_id: "plan" });

    expect(outcome.status).toBe("ok");
    expect(driver.calls()).toBe(3);
    // 重试的上下文包带上次失败摘要（让 worker 避开同一失败模式）
    expect(driver.prompts[1]).toContain("上次尝试失败");
    expect(driver.prompts[1]).toContain("boom-1");

    const events = await session.events.readOrdered();
    const started = events.filter((event) => event.type === "agent.task.started");
    const completed = events.filter((event) => event.type === "agent.task.completed");
    expect(started).toHaveLength(3);
    expect(completed).toHaveLength(3);
    expect(completed.map((event) => asPayload(event)["attempt"])).toEqual([1, 2, 3]);
    expect(completed.map((event) => asPayload(event)["status"])).toEqual(["failed", "failed", "ok"]);
    expect(asPayload(completed[2]!)["max_attempts"]).toBe(3);
  });

  it("重试耗尽：3 次全失败 → 终态 failed，runNode 不抛错", async () => {
    const driver = flakyDriver(3, "永远不会用到");
    const runner = createNodeRunner(DEF_RETRY, {
      resolveDriver: () => driver,
      workspaceRoot: root,
    });
    const node = DEF_RETRY.spec.nodes[1]!;
    const outcome = await runner.runNode(node, session, { workflow_id: "wf-retry", node_id: "plan" });

    expect(outcome.status).toBe("failed");
    expect(driver.calls()).toBe(3);
    const events = await session.events.readOrdered();
    const completed = events.filter((event) => event.type === "agent.task.completed");
    expect(completed).toHaveLength(3);
    expect(asPayload(completed[2]!)["error"]).toContain("boom-3");
  });

  it("无 retry 配置时失败一次即终（默认 max_attempts=1）", async () => {
    const driver = flakyDriver(5, "不会用到");
    const runner = createNodeRunner(DEF, {
      resolveDriver: () => driver,
      workspaceRoot: root,
    });
    const node = DEF.spec.nodes[1]!;
    const outcome = await runner.runNode(node, session, { workflow_id: "wf-agent", node_id: "plan" });
    expect(outcome.status).toBe("failed");
    expect(driver.calls()).toBe(1);
  });

  it("agent 自己写了 artifact → written_by=agent，不覆盖", async () => {
    const driver = fakeDriver([]);
    driver.run = async function* (task) {
      driver.prompts.push(task.prompt);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(session.dir, "plan.md"), "# Agent 自写计划\n", "utf8");
      yield { type: "result", data: { text: "已写入", session_id: "s-2" } } satisfies AgentEvent;
    };
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" });

    const written = await readFile(join(session.dir, "plan.md"), "utf8");
    expect(written).toBe("# Agent 自写计划\n");
    const events = await session.events.readOrdered();
    const completed = events.find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)["written_by"]).toBe("agent");
  });

  it("合法的嵌套 artifact → coordinator 创建父目录后原子写回", async () => {
    const def: WorkflowDef = {
      ...DEF,
      spec: {
        nodes: [
          {
            id: "nested",
            artifact: "reports/plan.md",
            depends_on: [],
            run: { agent: "fake-agent", readonly: false },
            gates: [],
          },
        ],
      },
    };
    const runner = createNodeRunner(def, {
      resolveDriver: () => okDriver("# 嵌套计划\n"),
      workspaceRoot: root,
    });
    const outcome = await runner.runNode(def.spec.nodes[0]!, session, {
      workflow_id: "wf-agent",
      node_id: "nested",
    });

    expect(outcome.status).toBe("ok");
    expect(await readFile(join(session.dir, "reports", "plan.md"), "utf8")).toContain("嵌套计划");
  });

  it("驱动解析失败 → completed{status:failed}，不抛错", async () => {
    const runner = createNodeRunner(DEF, {
      resolveDriver: () => {
        throw new Error("no driver for \"nope\"");
      },
      workspaceRoot: root,
    });
    const outcome = await runner.runNode(DEF.spec.nodes[1]!, session, {
      workflow_id: "wf-agent",
      node_id: "plan",
    });
    expect(outcome.status).toBe("failed");
    const events = await session.events.readOrdered();
    const completed = events.find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)["status"]).toBe("failed");
    expect(String(asPayload(completed!)["error"])).toContain("no driver");
  });

  it("agent 报错事件 → failed；超时类错误 → timeout", async () => {
    const failing = fakeDriver([
      { type: "error", data: { message: "boom", kind: "agent", session_id: "s-3" } },
    ]);
    const runner = createNodeRunner(DEF, { resolveDriver: () => failing, workspaceRoot: root });
    const outcome = await runner.runNode(DEF.spec.nodes[1]!, session, {
      workflow_id: "wf-agent",
      node_id: "plan",
    });
    expect(outcome.status).toBe("failed");

    const timingOut = fakeDriver([
      { type: "error", data: { message: "timed out", kind: "timeout" } },
    ]);
    const runner2 = createNodeRunner(DEF, { resolveDriver: () => timingOut, workspaceRoot: root });
    const outcome2 = await runner2.runNode(DEF.spec.nodes[1]!, session, {
      workflow_id: "wf-agent",
      node_id: "plan",
    });
    expect(outcome2.status).toBe("timeout");
  });

  it("readonly 节点不写 artifact", async () => {
    const def: WorkflowDef = {
      ...DEF,
      spec: {
        nodes: [
          {
            id: "review",
            depends_on: [],
            run: { agent: "fake-agent", readonly: true },
            gates: [],
          },
        ],
      },
    };
    const runner = createNodeRunner(def, { resolveDriver: () => okDriver("分析结论"), workspaceRoot: root });
    await runner.runNode(def.spec.nodes[0]!, session, { workflow_id: "wf-agent", node_id: "review" });
    const events = await session.events.readOrdered();
    const completed = events.find((event) => event.type === "agent.task.completed");
    expect(asPayload(completed!)["written_by"]).toBe("none");
  });

  it("越界 artifact → 任务失败事件，不写出 session 目录", async () => {
    const def: WorkflowDef = {
      ...DEF,
      spec: {
        nodes: [
          {
            id: "unsafe",
            artifact: "../outside.md",
            depends_on: [],
            run: { agent: "fake-agent", readonly: false },
            gates: [],
          },
        ],
      },
    };
    const driver = okDriver("不应派发");
    const runner = createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root });
    const outcome = await runner.runNode(def.spec.nodes[0]!, session, {
      workflow_id: "wf-agent",
      node_id: "unsafe",
    });

    expect(outcome.status).toBe("failed");
    expect(driver.prompts).toHaveLength(0);
    await expect(readFile(join(root, "outside.md"), "utf8")).rejects.toThrow();
    const completed = (await session.events.readOrdered()).find((event) => event.type === "agent.task.completed");
    expect(String(asPayload(completed!)["error"])).toContain("必须位于 session 目录内");
  });
});

// ---------------------------------------------------------------------------
// 上下文包
// ---------------------------------------------------------------------------

describe("上下文包（buildContextPack）", () => {
  it("含 PRD 全文、上游产物、账本与定位符；占位文档不算内容", async () => {
    await session.events.append({
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      session_id: "REQ-1",
      type: "session.created",
      schema_version: "1",
      actor: { kind: "human", id: "tester" },
      correlation_id: null,
      payload: { req_id: "REQ-1", title: "测试需求" },
      source: { adapter: "test" },
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(session.dir, "prd.md"), "# PRD\n\n做一个东西。\n", "utf8");
    await writeFile(join(session.dir, "adr.md"), "# ADR\n\n## 决策\n用 A 方案。\n", "utf8");
    const snapshot = await readSnapshot(session);
    snapshot.workflow.exited.push("intake");

    const pack = buildContextPack(DEF, DEF.spec.nodes[1]!, snapshot);
    expect(pack).toContain("测试需求");
    expect(pack).toContain("做一个东西");
    expect(pack).toContain("定位符层");
    expect(pack).toContain("cord/REQ-1/prd.md");
    expect(pack).toContain("cord/REQ-1/plan.md"); // 输出要求
    // plan.md 是占位文档（initSession 生成），不应作为内容进包
    expect(pack).not.toContain("占位文档");
  });

  it("run.prompt 模板占位符渲染", async () => {
    const def: WorkflowDef = {
      ...DEF,
      spec: {
        nodes: [
          {
            id: "custom",
            artifact: "findings.md",
            depends_on: [],
            run: { agent: "a", prompt: "请验证 {{req_id}} 的 {{artifact}}，节点 {{node_id}}", readonly: false },
            gates: [],
          },
        ],
      },
    };
    const snapshot = await readSnapshot(session);
    const pack = buildContextPack(def, def.spec.nodes[0]!, snapshot);
    expect(pack).toContain("请验证 REQ-1 的 findings.md，节点 custom");
  });

  it("动态采集 workflow artifact，并随文件变化更新 snapshot provenance", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(session.dir, "design.md"), "# 自定义设计\n\n第一版。\n", "utf8");
    const def: WorkflowDef = {
      ...DEF,
      spec: {
        nodes: [
          { id: "design", artifact: "design.md", depends_on: [], gates: [] },
          { id: "plan", artifact: "plan.md", depends_on: ["design"], gates: [] },
        ],
      },
    };
    const files = def.spec.nodes.flatMap((node) => node.artifact === undefined ? [] : [node.artifact]);
    const snapshot = await readSnapshot(session, { files });
    snapshot.workflow.exited.push("design");
    const pack = buildContextPack(def, def.spec.nodes[1]!, snapshot);

    expect(pack).toContain("自定义设计");
    expect(pack).toContain("cord/REQ-1/design.md");
    expect(snapshot.docs.find((doc) => doc.file === "design.md")?.content_hash).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(session.dir, "design.md"), "# 自定义设计\n\n第二版。\n", "utf8");
    const changed = await readSnapshot(session, { files });
    expect(changed.snapshot_id).not.toBe(snapshot.snapshot_id);
    expect(changed.docs.find((doc) => doc.file === "design.md")?.content).toContain("第二版");
  });
});

// ---------------------------------------------------------------------------
// 执行器集成：node.run 经 NodeRunner 派发 + 恢复不重复执行
// ---------------------------------------------------------------------------

describe("执行器 × node.run", () => {
  const humanGate = { ask: async () => "确认放行" };

  it("同一 run 的下一个 worker 看见刚更新的 PRD 和未刷磁盘投影的新账本事件", async () => {
    await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_ONE");
    const def: WorkflowDef = { ...DEF, spec: { nodes: [
      DEF.spec.nodes[0]!, DEF.spec.nodes[1]!,
      { id: "review", depends_on: ["plan"], run: { agent: "fake-agent", readonly: true }, gates: [] },
    ] } };
    const driver = fakeDriver([]);
    driver.run = async function* (task) {
      driver.prompts.push(task.prompt);
      if (driver.prompts.length === 1) {
        await writeFile(join(session.dir, "prd.md"), "# PRD\nVERSION_TWO");
        for (const [type, payload] of [
          ["ledger.entry.proposed", { entry_id: "C-99", title: "LATEST_CONFIRMED_DECISION", anchors: [{ kind: "doc", anchor: "prd.md" }] }],
          ["ledger.entry.confirmed", { entry_id: "C-99" }],
        ] as const) {
          await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null, payload, source: { adapter: "test" } });
        }
      }
      yield { type: "result", data: { text: "# 节点产物" } };
    };
    await createExecutor({ humanGate, nodeRunner: createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root }) }).run(def, session);
    expect(driver.prompts[0]).toContain("VERSION_ONE");
    expect(driver.prompts[1]).toContain("VERSION_TWO");
    expect(driver.prompts[1]).not.toContain("VERSION_ONE");
    expect(driver.prompts[1]).toContain("[confirmed] C-99 LATEST_CONFIRMED_DECISION");
    expect((await session.readLedger()).entries).toEqual([]);
  });

  it("声明 run 的节点经 NodeRunner 执行并完成流程", async () => {
    const driver = okDriver("# Plan\n\n由 agent 产出。\n");
    const executor = createExecutor({
      humanGate,
      nodeRunner: createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root }),
    });
    await executor.run(DEF, session);

    const events = await session.events.readOrdered();
    const types = events.map((event) => event.type);
    expect(types).toContain("agent.task.started");
    expect(types).toContain("agent.task.completed");
    const exited = events.filter((event) => event.type === "workflow.node.exited");
    expect(exited).toHaveLength(3);
    expect(driver.prompts).toHaveLength(1);
  });

  it("恢复扫点：agent 任务已 ok 的节点不重复执行", async () => {
    const driver = okDriver("# Plan\n\nv1\n");
    const runner = createNodeRunner(DEF, { resolveDriver: () => driver, workspaceRoot: root });
    const executor = createExecutor({ humanGate, nodeRunner: runner });

    const append = session.events.append.bind(session.events);
    const interruption = vi.spyOn(session.events, "append").mockImplementation(async (draft) => {
      if (draft.type === "workflow.node.exited" && asPayload(draft).node_id === "plan") throw new Error("interrupted before node exit");
      return append(draft);
    });
    await expect(executor.run(DEF, session)).rejects.toThrow("interrupted before node exit");
    interruption.mockRestore();
    await executor.run(DEF, session);

    const events = await session.events.readOrdered();
    const completed = events.filter((event) => event.type === "agent.task.completed");
    // 恢复时 agentDone 命中 → 不重复派发（仍只有 1 次 completed）
    expect(completed).toHaveLength(1);
    expect(driver.prompts).toHaveLength(1);
  });

  it("未注入 NodeRunner 时 node.run 被跳过并记 notes（fail-visible）", async () => {
    const executor = createExecutor({ humanGate });
    await executor.run(DEF, session);
    const events = await session.events.readOrdered();
    const exited = events.find(
      (event) => event.type === "workflow.node.exited" && asPayload(event)["node_id"] === "plan",
    );
    const notes = asPayload(exited!)["notes"];
    expect(Array.isArray(notes)).toBe(true);
    expect(String((notes as string[])[0])).toContain("NodeRunner");
  });

  it("agent 任务失败 → 节点不退出，run 停在该节点", async () => {
    const failing = fakeDriver([{ type: "error", data: { message: "boom", kind: "agent" } }]);
    const executor = createExecutor({
      humanGate,
      nodeRunner: createNodeRunner(DEF, { resolveDriver: () => failing, workspaceRoot: root }),
    });
    await executor.run(DEF, session);
    const events = await session.events.readOrdered();
    const exited = events.filter((event) => event.type === "workflow.node.exited");
    // intake 退出；plan 停在执行体失败；done 未到达
    expect(exited.map((event) => asPayload(event)["node_id"])).toEqual(["intake"]);
  });
});
