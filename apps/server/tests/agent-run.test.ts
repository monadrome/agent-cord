/**
 * agent 执行端到端测试（ADR-0023/0024）：真实 server + agents.yaml 注册 fake agent +
 * 自定义 node.run SDLC —— 启动 run 后协调 agent 经驱动派发任务，artifact 写回，
 * 参数化 checker（file-nonempty）验收产物，run 完成。
 * fake agent = tests/driver/fixtures/fake-cli.mjs（不调用真实 CLI、不打网络）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "tests", "driver", "fixtures", "fake-cli.mjs",
);

let root: string;
let server: BuiltServer;
let base: string;

const AGENT_SDLC = `apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata: { id: agent-sdlc, name: Agent 流程 }
spec:
  nodes:
    - id: intake
      artifact: prd.md
      depends_on: []
      gates: []
    - id: plan
      artifact: plan.md
      depends_on: [intake]
      run: { agent: fake, timeout_ms: 30000 }
      gates:
        - id: plan-written
          role: { initiators: [], approvers: [] }
          attach: { node: plan, when: post, triggers: [] }
          checks: [{ ref: file-nonempty, with: { path: plan.md } }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: []
    - id: done
      depends_on: [plan]
      gates: []
`;

async function api(
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-agent-run-"));
  // 工作区 agent 注册表：fake agent = fake-cli fixture（ADR-0023 决策 6）
  await mkdir(join(root, "cord"), { recursive: true });
  await writeFile(
    join(root, "cord", "agents.yaml"),
    `agents:\n  fake:\n    kind: headless\n    bin: ${process.execPath}\n    args: ["${fixture}", "--mode", "claude", "{{prompt}}"]\n`,
    "utf8",
  );
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

describe("agent 执行闭环（node.run + agents.yaml + 参数化 checker）", () => {
  it("快照文件不可读 → run failed 与任务阶段留痕；修复后重新 start 断点完成", async () => {
    await api("POST", "/api/v1/sdlcs/agent-sdlc/versions/publish", {
      body: { yaml: AGENT_SDLC }, key: "publish-recovery-sdlc",
    });
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-RECOVER", title: "快照故障恢复", prd: "# PRD\n最新需求" }, key: "create-recovery",
    });
    const plan_path = join(root, "cord", "REQ-RECOVER", "plan.md");
    await rm(plan_path);
    await mkdir(plan_path);
    const failed_run = await api("POST", "/api/v1/requirements/REQ-RECOVER/runs", {
      body: { sdlc_id: "agent-sdlc" }, key: "start-unreadable",
    });
    expect(failed_run.status).toBe(202);
    await waitFor(async () => {
      const runs = await api("GET", "/api/v1/requirements/REQ-RECOVER/runs");
      return runs.body.runs[0]?.status === "failed" && !server.runs.isActive("REQ-RECOVER");
    });
    const events = await api("GET", "/api/v1/requirements/REQ-RECOVER/events");
    const failure = events.body.events.find((event: { type: string }) => event.type === "agent.task.completed");
    expect(failure.payload).toMatchObject({ status: "failed", failure_stage: "snapshot", retryable: false });
    await rm(plan_path, { recursive: true });
    const recovered = await api("POST", "/api/v1/requirements/REQ-RECOVER/runs", {
      body: { sdlc_id: "agent-sdlc" }, key: "start-repaired",
    });
    expect(recovered.status).toBe(202);
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-RECOVER");
      return detail.body.requirement.status === "completed";
    });
    expect(await readFile(plan_path, "utf8")).toContain("final answer");
    const final_events = await api("GET", "/api/v1/requirements/REQ-RECOVER/events");
    expect(final_events.body.events.filter((event: { type: string; payload: any }) =>
      event.type === "workflow.node.exited" && event.payload.node_id === "intake",
    )).toHaveLength(1);
  });

  it("发布 agent SDLC → 启动 run → agent.task 事件 → artifact 代写 → completed", async () => {
    // 校验 + 发布自定义 SDLC（带 node.run 与参数化 checker）
    const validated = await api("POST", "/api/v1/sdlcs/agent-sdlc/versions/validate", {
      body: { yaml: AGENT_SDLC },
    });
    expect(validated.body.validation.ok).toBe(true);

    const published = await api("POST", "/api/v1/sdlcs/agent-sdlc/versions/publish", {
      body: { yaml: AGENT_SDLC },
      key: "publish-agent-sdlc",
    });
    expect(published.status).toBe(201);
    expect(published.body.version).toBe(1);

    // 创建需求并绑定该 SDLC 启动 run
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-AGENT", title: "agent 执行验证", prd: "# PRD\n\n写一个计划。\n" },
      key: "create-req-agent",
    });
    const started = await api("POST", "/api/v1/requirements/REQ-AGENT/runs", {
      body: { sdlc_id: "agent-sdlc", sdlc_version: 1 },
      key: "start-agent-run",
    });
    expect(started.status).toBe(202);
    expect(started.body.run.sdlc_id).toBe("agent-sdlc");

    // 等待 run 完成
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-AGENT");
      return detail.body.requirement.status === "completed";
    });

    // agent.task 事件链完整：started → completed{status:ok, written_by:coordinator}
    const events = await api("GET", "/api/v1/requirements/REQ-AGENT/events");
    const types = events.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain("agent.task.started");
    expect(types).toContain("agent.task.completed");
    const completed = events.body.events.find(
      (event: { type: string }) => event.type === "agent.task.completed",
    );
    expect(completed.payload.status).toBe("ok");
    expect(completed.payload.artifact_written).toBe(true);
    expect(completed.payload.written_by).toBe("coordinator");
    expect(completed.payload.agent_session_id).toBe("fake-session-1");

    // artifact 落盘（fake agent 只回文本，coordinator 代写）
    const plan = await readFile(join(root, "cord", "REQ-AGENT", "plan.md"), "utf8");
    expect(plan).toContain("final answer");

    // plan-written gate 经参数化 checker 放行
    const gateResolved = events.body.events.find(
      (event: { type: string; payload: any }) =>
        event.type === "gate.resolved" && event.payload.gate_id === "plan-written",
    );
    expect(gateResolved.payload.result).toBe("pass");
    expect(gateResolved.payload.checks[0].ref).toBe("file-nonempty");
  });

  it("run.agent 未知 → run 终态 failed（agent.task.completed{status:failed}）", async () => {
    const badSdlc = AGENT_SDLC.replace("agent: fake", "agent: nope-missing");
    await api("POST", "/api/v1/sdlcs/bad-sdlc/versions/publish", {
      body: { yaml: badSdlc },
      key: "publish-bad-sdlc",
    });
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-BAD", title: "未知 agent" },
      key: "create-req-bad",
    });
    await api("POST", "/api/v1/requirements/REQ-BAD/runs", {
      body: { sdlc_id: "bad-sdlc" },
      key: "start-bad-run",
    });

    await waitFor(async () => {
      const runs = await api("GET", "/api/v1/requirements/REQ-BAD/runs");
      return runs.body.runs[0]?.status === "failed";
    });
    const runs = await api("GET", "/api/v1/requirements/REQ-BAD/runs");
    expect(runs.body.runs[0].status).toBe("failed");
  });
});
