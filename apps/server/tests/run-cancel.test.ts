/**
 * run 取消测试（ADR-0025）：workflow.run.cancelled 落盘 → 执行器节点边界止步 /
 * 人工挂起唤醒 / agent 子进程收束；幂等重取消；取消后审批失效；重启 run 可恢复。
 * fake agent = tests/driver/fixtures/fake-cli.mjs（--sleep 模拟长时间任务，不打网络）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const SLOW_AGENT_SDLC = `apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata: { id: slow-sdlc, name: 慢 agent 流程 }
spec:
  nodes:
    - id: intake
      artifact: prd.md
      depends_on: []
      gates: []
    - id: plan
      artifact: plan.md
      depends_on: [intake]
      run: { agent: slow, timeout_ms: 120000 }
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
  root = await mkdtemp(join(tmpdir(), "cord-cancel-"));
  await mkdir(join(root, "cord"), { recursive: true });
  // slow agent：打印首行后睡 60s（取消必须能抢先终止它）
  await writeFile(
    join(root, "cord", "agents.yaml"),
    `agents:\n  slow:\n    kind: headless\n    bin: ${process.execPath}\n    args: ["${fixture}", "--mode", "claude", "--sleep", "60000", "{{prompt}}"]\n`,
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

describe("run 取消（ADR-0025）", () => {
  it("取消等待人工的 run：事件落盘、终态 cancelled、审批失效、重取消幂等", async () => {
    // 默认 simple-sdlc 跑到 review 人工 gate
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-C1", title: "取消等待人工" },
      key: "create-c1",
    });
    const started = await api("POST", "/api/v1/requirements/REQ-C1/runs", { body: {}, key: "start-c1" });
    expect(started.status).toBe(202);
    const runId = started.body.run.run_id as string;

    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-C1");
      return detail.body.requirement.status === "waiting_human";
    });
    const approvals = await api("GET", "/api/v1/requirements/REQ-C1/approvals");
    expect(approvals.body.approvals.length).toBeGreaterThan(0);

    const cancelled = await api("POST", `/api/v1/runs/${runId}/cancel`, {
      body: { reason: "需求变更" },
      key: "cancel-c1",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe("cancelled");

    // 事件流有取消事实；审批投影清空（重启 run 前不再可决策）
    const events = await api("GET", "/api/v1/requirements/REQ-C1/events");
    const cancelEvent = events.body.events.find(
      (event: { type: string }) => event.type === "workflow.run.cancelled",
    );
    expect(cancelEvent.payload.run_id).toBe(runId);
    expect(cancelEvent.payload.reason).toBe("需求变更");

    const after = await api("GET", "/api/v1/requirements/REQ-C1/approvals");
    expect(after.body.approvals).toHaveLength(0);

    // 幂等重取消：返回现状、不重复落事件
    const again = await api("POST", `/api/v1/runs/${runId}/cancel`, { body: {}, key: "cancel-c1-again" });
    expect(again.status).toBe(200);
    expect(again.body.run.status).toBe("cancelled");
    const events2 = await api("GET", "/api/v1/requirements/REQ-C1/events");
    expect(
      events2.body.events.filter((event: { type: string }) => event.type === "workflow.run.cancelled"),
    ).toHaveLength(1);
  });

  it("取消进行中的 agent 任务：completed{status:cancelled}，进程被收束", async () => {
    const pub = await api("POST", "/api/v1/sdlcs/slow-sdlc/versions/publish", {
      body: { yaml: SLOW_AGENT_SDLC },
      key: "publish-slow",
    });
    expect(pub.status).toBe(201);
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-C2", title: "取消 agent 任务" },
      key: "create-c2",
    });
    const started = await api("POST", "/api/v1/requirements/REQ-C2/runs", {
      body: { sdlc_id: "slow-sdlc" },
      key: "start-c2",
    });
    expect(started.status).toBe(202);
    const runId = started.body.run.run_id as string;

    // 等 agent 任务真的跑起来（started 落盘）
    await waitFor(async () => {
      const events = await api("GET", "/api/v1/requirements/REQ-C2/events");
      return events.body.events.some((event: { type: string }) => event.type === "agent.task.started");
    });

    const begin = Date.now();
    const cancelled = await api("POST", `/api/v1/runs/${runId}/cancel`, { body: {}, key: "cancel-c2" });
    // 60s 的 sleep 被抢先终止 → 取消应远快于任务自然结束
    expect(Date.now() - begin).toBeLessThan(15_000);
    expect(cancelled.body.run.status).toBe("cancelled");

    const events = await api("GET", "/api/v1/requirements/REQ-C2/events");
    const completed = events.body.events.find(
      (event: { type: string }) => event.type === "agent.task.completed",
    );
    expect(completed.payload.status).toBe("cancelled");

    const runs = await api("GET", "/api/v1/requirements/REQ-C2/runs");
    expect(runs.body.runs[0].status).toBe("cancelled");
  });

  it("取消不存在的 run → 404；取消后重新 start 可从断点续跑", async () => {
    const missing = await api("POST", "/api/v1/runs/nope/cancel", { body: {}, key: "cancel-nope" });
    expect(missing.status).toBe(404);

    // 取消后重跑：同一需求可再启动（取消不占在途槽位）
    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-C3", title: "取消后重跑" },
      key: "create-c3",
    });
    const first = await api("POST", "/api/v1/requirements/REQ-C3/runs", { body: {}, key: "start-c3-a" });
    const firstRunId = first.body.run.run_id as string;
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-C3");
      return detail.body.requirement.status === "waiting_human";
    });
    await api("POST", `/api/v1/runs/${firstRunId}/cancel`, { body: {}, key: "cancel-c3" });

    const restarted = await api("POST", "/api/v1/requirements/REQ-C3/runs", { body: {}, key: "start-c3-b" });
    expect(restarted.status).toBe(202);
    expect(restarted.body.run.run_id).not.toBe(firstRunId);
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-C3");
      return detail.body.requirement.status === "waiting_human";
    });
    // 恢复的 run 重新发起审批
    const approvals = await api("GET", "/api/v1/requirements/REQ-C3/approvals");
    expect(approvals.body.approvals.length).toBeGreaterThan(0);
  });
});
