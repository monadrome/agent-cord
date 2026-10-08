import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function workflowYaml(human_confirm = false, inputs?: string[]): string {
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
            checks: [{ ref: "verification-passed", with: { verification_id: "unit-tests", ...(inputs === undefined ? {} : { inputs }) } }],
            pass: { require: "all", human_confirm },
            on_fail: "escalate",
          }],
        },
      ],
    },
  });
}

async function listen(): Promise<void> {
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  base = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-verification-"));
  await listen();
});

afterEach(async () => {
  for (const run of server.runs.listRuns()) {
    if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  }
  await server.app.close();
  server.index.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function setupRun(options: { human_confirm?: boolean; inputs?: string[]; before_ask?: () => Promise<void> } = {}): Promise<{ runId: string; approvalId: string }> {
  const created = await api("POST", "/api/v1/requirements", { req_id: "REQ-VERIFY", title: "机器验证", prd: "# PRD\n\n目标：验证机器证据。" }, "create");
  expect(created.status).toBe(201);
  if (options.before_ask !== undefined) {
    const session = await server.sessions.open("REQ-VERIFY");
    const append = session.events.append.bind(session.events);
    let paused = false;
    vi.spyOn(session.events, "append").mockImplementation(async (draft) => {
      const event = await append(draft);
      if (!paused && draft.type === "gate.waiting") {
        paused = true;
        await options.before_ask!();
      }
      return event;
    });
  }
  const published = await api("POST", "/api/v1/sdlcs/machine-verification/versions/publish", { yaml: workflowYaml(options.human_confirm, options.inputs) }, "publish");
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

async function restart(before_start?: () => Promise<void>): Promise<void> {
  await server.app.close();
  server.index.close();
  await before_start?.();
  await listen();
}

async function submitVerification(run_id: string, key: string, status = "passed") {
  const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${run_id}/nodes/verify/verification-context`);
  expect(context.status).toBe(200);
  return api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${run_id}/verifications`, {
    run_id, node_id: "verify", verification_id: "unit-tests",
    input_hash: context.body.verification.input_hash, command_hash: "d".repeat(64), status,
    exit_code: status === "passed" ? 0 : 1,
  }, key);
}

describe("结构化机器验证事实", () => {
  it("源码范围出现非法链接后 fail-closed，修复后仍可提交", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    const { runId } = await setupRun({ inputs: ["src"] });
    const url = `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`;
    const first = await api("GET", url);
    await rm(join(root, "src", "draft.ts"));
    await writeFile(join(root, "outside.ts"), "PRIVATE_SOURCE_CONTENT");
    await symlink(join(root, "outside.ts"), join(root, "src", "draft.ts"));
    const rejected = await api("GET", url);
    expect(rejected.status).toBe(409);
    expect(JSON.stringify(rejected.body)).not.toContain("PRIVATE_SOURCE_CONTENT");
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, {
      run_id: runId, node_id: "verify", verification_id: "unit-tests", input_hash: first.body.verification.input_hash,
      command_hash: "b".repeat(64), status: "passed", exit_code: 0,
    }, "linked-source")).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "verification.completed")).toHaveLength(0);
    await rm(join(root, "src", "draft.ts"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    expect((await submitVerification(runId, "fixed-source")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
  });

  it("已通过的源码在重启时不可读，server 保持可用且 run 不推进", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    const { runId } = await setupRun({ inputs: ["src"], human_confirm: true });
    expect((await submitVerification(runId, "before-missing")).status).toBe(200);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-VERIFY"))[0]?.kind === "human_confirm");
    await restart(() => rm(join(root, "src"), { recursive: true }));
    expect((await api("GET", "/api/v1/health")).body.ok).toBe(true);
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    expect((await server.runs.getRun(runId)).status).toBe("waiting_human");
    expect((await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`)).status).toBe(409);
    const approval = (await server.sessions.listApprovals("REQ-VERIFY"))[0]!;
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/approvals/${approval.approval_id}/decide`, { choice: "确认放行" }, "missing-source-decision")).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    expect((await submitVerification(runId, "after-restored")).status).toBe(200);
    let restored: any;
    await waitFor(async () => {
      restored = (await server.sessions.listApprovals("REQ-VERIFY"))[0];
      return restored?.kind === "human_confirm" && restored?.approval_id !== approval.approval_id;
    });
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/approvals/${restored.approval_id}/decide`, { choice: "确认放行" }, "restored-source-decision")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
  });

  it.each(["edit", "add", "delete"])("声明的代码目录发生 %s 后拒绝旧测试结果，重新验证可恢复", async (change) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    const { runId } = await setupRun({ inputs: ["src"] });
    const url = `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`;
    const first = await api("GET", url);
    if (change === "edit") await writeFile(join(root, "src", "draft.ts"), "export const draft = 2;\n");
    if (change === "add") await writeFile(join(root, "src", "new.ts"), "export const added = true;\n");
    if (change === "delete") await rm(join(root, "src", "draft.ts"));
    const current = await api("GET", url);
    expect(current.status).toBe(200);
    expect(current.body.verification.input_hash).not.toBe(first.body.verification.input_hash);
    expect(current.body.verification.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(current.body.verification.source_inputs).toEqual(["src"]);
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, {
      run_id: runId, node_id: "verify", verification_id: "unit-tests", status: "passed", exit_code: 0,
      command_hash: "b".repeat(64), input_hash: first.body.verification.input_hash,
    }, "old-code")).status).toBe(409);
    expect((await submitVerification(runId, "current-code")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    const result = (await server.sessions.readEvents("REQ-VERIFY")).find((event) => event.type === "verification.completed");
    expect((result?.payload as any).source_hash).toBe(current.body.verification.source_hash);
    expect(JSON.stringify(result)).not.toContain("export const");
  });

  it("机器通过后代码改变，人工审批和重启恢复都不得继续使用旧结果", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 1;\n");
    const { runId } = await setupRun({ inputs: ["src"], human_confirm: true });
    expect((await submitVerification(runId, "source-reviewed")).status).toBe(200);
    let approval: any;
    await waitFor(async () => {
      approval = (await server.sessions.listApprovals("REQ-VERIFY"))[0];
      return approval?.kind === "human_confirm";
    });
    await writeFile(join(root, "src", "draft.ts"), "export const draft = 2;\n");
    await restart();
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/approvals/${approval.approval_id}/decide`, { choice: "确认放行" }, "old-source-approval")).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    let replacement: any;
    await waitFor(async () => {
      replacement = (await server.sessions.listApprovals("REQ-VERIFY"))[0];
      return replacement?.kind === "escalation";
    });
    expect(replacement.approval_id).not.toBe(approval.approval_id);
    expect((await submitVerification(runId, "new-source-reviewed")).status).toBe(200);
    await waitFor(async () => (server.sessions.listApprovals("REQ-VERIFY")).then((items) => items[0]?.kind === "human_confirm"));
  });

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

  it("重启后 CI 才提交验证，恢复原 run 且并发提交不重复启动 executor", async () => {
    const { runId } = await setupRun();
    await restart();
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    const responses = await Promise.all([
      submitVerification(runId, "after-restart-a"),
      submitVerification(runId, "after-restart-b"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    expect(server.runs.listRuns("REQ-VERIFY").map((run) => run.run_id)).toEqual([runId]);
    const events = await server.sessions.readEvents("REQ-VERIFY");
    expect(events.filter((event) => event.type === "workflow.node.entered" && (event.payload as any).node_id === "verify")).toHaveLength(2);
    expect(events.filter((event) => event.type === "workflow.node.exited" && (event.payload as any).node_id === "verify")).toHaveLength(1);
    expect(events.filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("结果在 gate.waiting 落盘后、挂起 Promise 建立前到达也可唤醒", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const { runId } = await setupRun({ before_ask: () => barrier });
    try {
      expect((await submitVerification(runId, "before-ask")).status).toBe(200);
    } finally {
      release();
    }
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("机器通过后仍需人工终审，重启不因已消费验证重新生成审批", async () => {
    const { runId, approvalId } = await setupRun({ human_confirm: true });
    expect((await submitVerification(runId, "human-required")).status).toBe(200);
    let current: any;
    await waitFor(async () => {
      current = (await api("GET", "/api/v1/requirements/REQ-VERIFY/approvals")).body.approvals[0];
      return current?.kind === "human_confirm";
    });
    expect(current.approval_id).not.toBe(approvalId);
    await restart();
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    expect((await api("GET", "/api/v1/requirements/REQ-VERIFY/approvals")).body.approvals[0].approval_id).toBe(current.approval_id);
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/approvals/${current.approval_id}/decide`, { choice: "确认放行" }, "human-decision")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(1);
  });

  it("同 run 的无关验证不会使当前机器等待或人工审批失效", async () => {
    const { runId, approvalId } = await setupRun();
    const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`);
    const response = await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, {
      run_id: runId, node_id: "verify", verification_id: "unrelated-lint",
      input_hash: context.body.verification.input_hash, command_hash: "e".repeat(64), status: "passed", exit_code: 0,
    }, "unrelated");
    expect(response.status).toBe(200);
    expect((await server.sessions.listApprovals("REQ-VERIFY")).map((approval) => approval.approval_id)).toEqual([approvalId]);
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "gate.invalidated")).toHaveLength(0);
    expect((await submitVerification(runId, "actual-unit-tests")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
  });

  it("失败结果经重检仍等待，重启不重复消费，新的通过结果可恢复", async () => {
    const { runId, approvalId } = await setupRun();
    expect((await submitVerification(runId, "failed-tests", "failed")).status).toBe(200);
    let failed_approval: any;
    await waitFor(async () => {
      failed_approval = (await server.sessions.listApprovals("REQ-VERIFY"))[0];
      return failed_approval?.approval_id !== approvalId && failed_approval?.reason.includes("=failed");
    });
    await restart();
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    expect((await server.sessions.listApprovals("REQ-VERIFY"))[0]?.approval_id).toBe(failed_approval.approval_id);
    expect((await submitVerification(runId, "fixed-tests")).status).toBe(200);
    await waitFor(async () => (await server.runs.getRun(runId)).status === "completed");
    const events = await server.sessions.readEvents("REQ-VERIFY");
    expect(events.filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    expect(events.filter((event) => event.type === "verification.completed").map((event) => (event.payload as any).status)).toEqual(["failed", "passed"]);
  });

  it("重启后取消等待中的 run，迟到的验证不得写入或恢复 executor", async () => {
    const { runId } = await setupRun();
    await restart();
    const context = await api("GET", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/nodes/verify/verification-context`);
    expect((await api("POST", `/api/v1/runs/${runId}/cancel`, { reason: "拒绝本轮验证" }, "cancel-wait")).status).toBe(200);
    expect((await api("POST", `/api/v1/requirements/REQ-VERIFY/runs/${runId}/verifications`, {
      run_id: runId, node_id: "verify", verification_id: "unit-tests",
      input_hash: context.body.verification.input_hash, command_hash: "e".repeat(64), status: "passed", exit_code: 0,
    }, "after-cancel")).status).toBe(409);
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    expect((await server.runs.getRun(runId)).status).toBe("cancelled");
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "verification.completed")).toHaveLength(0);
  });

  it("验证提交恢复期间取消，启动前读取最新状态且不复活 run", async () => {
    const { runId } = await setupRun();
    await restart();
    let at_launch!: () => void;
    const reached = new Promise<void>((resolve) => { at_launch = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const latest = server.runs.latestRun.bind(server.runs);
    let calls = 0;
    vi.spyOn(server.runs, "latestRun").mockImplementation(async (req_id) => {
      if (++calls === 2) {
        at_launch();
        await barrier;
      }
      return latest(req_id);
    });
    const submission = submitVerification(runId, "cancel-during-recovery");
    try {
      await reached;
      expect((await api("POST", `/api/v1/runs/${runId}/cancel`, { reason: "恢复期间取消" }, "cancel-recovery")).status).toBe(200);
    } finally {
      release();
    }
    expect((await submission).status).toBe(200);
    expect(server.runs.isActive("REQ-VERIFY")).toBe(false);
    expect((await server.runs.getRun(runId)).status).toBe("cancelled");
    expect((await server.sessions.readEvents("REQ-VERIFY")).filter((event) => event.type === "workflow.node.entered" && (event.payload as any).node_id === "verify")).toHaveLength(1);
  });
});
