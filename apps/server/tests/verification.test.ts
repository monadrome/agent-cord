import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

let root: string;
let server: BuiltServer;
let base: string;

async function api(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== undefined) headers["idempotency-key"] = key;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待验证流程超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function workflowYaml(): string {
  return YAML.stringify({
    apiVersion: "agent-cord.dev/v1alpha1",
    kind: "Workflow",
    metadata: { id: "machine-verification" },
    spec: {
      nodes: [
        {
          id: "intake",
          gates: [{
            id: "intake-ready",
            role: {},
            attach: { node: "intake", when: "post" },
            checks: [{ ref: "file-nonempty", with: { path: "prd.md" } }],
            pass: { require: "all", human_confirm: false },
            on_fail: "block",
          }],
        },
        {
          id: "verify",
          depends_on: ["intake"],
          gates: [{
            id: "machine-evidence",
            role: {},
            attach: { node: "verify", when: "post" },
            checks: [{ ref: "verification-passed", with: { verification_id: "unit-tests" } }],
            pass: { require: "all", human_confirm: false },
            on_fail: "escalate",
          }],
        },
      ],
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-verification-"));
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

async function setupRun(): Promise<{ runId: string; approvalId: string }> {
  const created = await api("POST", "/api/v1/requirements", { req_id: "REQ-VERIFY", title: "机器验证", prd: "# PRD\n\n目标：验证机器证据。" }, "create");
  expect(created.status).toBe(201);
  const published = await api("POST", "/api/v1/sdlcs/machine-verification/versions/publish", { yaml: workflowYaml() }, "publish");
  expect(published.status).toBe(201);
  const started = await api("POST", "/api/v1/requirements/REQ-VERIFY/runs", { sdlc_id: "machine-verification", sdlc_version: 1 }, "run");
  expect(started.status).toBe(202);
  let approval: any;
  await waitFor(async () => {
    const result = await api("GET", "/api/v1/requirements/REQ-VERIFY/approvals");
    approval = result.body.approvals[0];
    return approval !== undefined;
  });
  return { runId: started.body.run.run_id, approvalId: approval.approval_id };
}

describe("结构化机器验证事实", () => {
  it("上下文 hash 绑定当前输入，结果经 gate 消费并支持幂等重放", async () => {
    const { runId, approvalId } = await setupRun();
    expect(approvalId).toBeTruthy();
    const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`);
    expect(context.status).toBe(200);
    expect(context.body.verification.node_id).toBe("verify");
    const payload = {
      run_id: runId,
      node_id: "verify",
      verification_id: "unit-tests",
      input_hash: context.body.verification.input_hash,
      command_hash: "b".repeat(64),
      status: "passed",
      exit_code: 0,
      duration_ms: 123,
      summary: "host test suite passed",
    };
    const recorded = await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, payload, "verification");
    expect(recorded.status).toBe(200);
    const replay = await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, payload, "verification");
    expect(replay.status).toBe(200);
    expect(replay.body.event_id).toBe(recorded.body.event_id);

    await waitFor(async () => (await api("GET", `/api/v1/runs/${runId}`)).body.run.status === "completed");
    const events = await api("GET", "/api/v1/requirements/REQ-VERIFY/events");
    expect(events.body.events.filter((event: any) => event.type === "verification.completed")).toHaveLength(1);
    const resolved = events.body.events.find((event: any) => event.type === "gate.resolved" && event.payload.node_id === "verify");
    expect(resolved.payload.checks[0]).toMatchObject({ ref: "verification-passed", result: "pass" });
    expect(events.body.events.find((event: any) => event.type === "verification.completed").payload.run_id).toBe(runId);
  });

  it("需求输入变化后拒绝旧 verification hash，且不写入事实", async () => {
    const { runId } = await setupRun();
    const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`);
    const changed = await api("PUT", "/api/v1/requirements/REQ-VERIFY/docs/prd", { content: "# PRD\n\n已变化" }, "change-prd");
    expect(changed.status).toBe(200);
    const rejected = await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, {
      run_id: runId,
      node_id: "verify",
      verification_id: "unit-tests",
      input_hash: context.body.verification.input_hash,
      command_hash: "b".repeat(64),
      status: "passed",
    }, "stale-verification");
    expect(rejected.status).toBe(409);
    const events = await api("GET", "/api/v1/requirements/REQ-VERIFY/events");
    expect(events.body.events.some((event: any) => event.type === "verification.completed")).toBe(false);
    await api("POST", `/api/v1/runs/${runId}/cancel`, { reason: "test cleanup" }, "cancel");
  });

  it("验证事实在 server 重启前落盘时，恢复同一 run 并重检 gate", async () => {
    const { runId } = await setupRun();
    const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`);
    const versioned = await server.sdlcs.get("machine-verification", 1);
    await server.sessions.recordVerification("REQ-VERIFY", {
      run_id: runId,
      node_id: "verify",
      verification_id: "unit-tests",
      input_hash: context.body.verification.input_hash,
      command_hash: "c".repeat(64),
      status: "passed",
      workflow_id: versioned.def.metadata.id,
      workflow_revision: versioned.workflow_revision,
    });
    await server.app.close();
    server.index.close();
    server = await buildApp({ root });
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    const events = await server.sessions.readEvents("REQ-VERIFY");
    expect(events.some((event) => event.type === "gate.resolved" && (event.payload as any).node_id === "verify")).toBe(true);
  });
});
