/**
 * 协调 agent 测试（ADR-0023）：快照/上下文包/事件落盘/artifact 双通道写回/恢复不重复执行。
 * driver 用内存 fake（不 spawn 子进程）；session 用真实 initSession（tmpdir）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

// ---------------------------------------------------------------------------
// 执行器集成：node.run 经 NodeRunner 派发 + 恢复不重复执行
// ---------------------------------------------------------------------------

describe("执行器 × node.run", () => {
  const humanGate = { ask: async () => "确认放行" };

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

    // 第一次：跑到 plan 的任务完成、但制造「未退出」状态（人工制造中断：只跑到 started/completed）
    await runner.runNode(DEF.spec.nodes[1]!, session, { workflow_id: "wf-agent", node_id: "plan" });
    // 补一条 node.entered 在任务完成之前（模拟真实顺序：entered → started → completed，无 exited）
    // 注意：上面 runNode 直接调用没有 entered 事件；这里模拟恢复场景 = 有 completed 无 exited
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
