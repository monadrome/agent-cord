import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalRetryAuthorizedPayloadSchema, readGoalRecoveryRequest, readGoalRetryAgentIdentity, readGoalRetryAuthorization, type EventEnvelope } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { RunStartGuard } from "../src/services/run-service.js";
import { createClient } from "../../console/src/api.js";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-supervisor.mjs", import.meta.url));
const lease_holder = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
let root: string;
let server: BuiltServer | undefined;
let sequence = 0;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-goal-retry-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });
async function api(method: "GET" | "POST", url: string, payload?: unknown, key = "retry-" + sequence++) {
  const response = await server!.app.inject({ method, url: "/api/v1" + url, ...(method === "POST" ? { headers: { "idempotency-key": key } } : {}), ...(payload === undefined ? {} : { payload }) });
  return { status: response.statusCode, body: response.json() };
}
async function waitFor(check: () => Promise<boolean>) { const deadline = Date.now() + 12000; while (!await check()) { if (Date.now() > deadline) throw Error("Goal 续跑等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function facts() { return (await server!.sessions.open("REQ-RETRY")).events.readOrdered(); }
async function round() { return (await api("GET", "/requirements/REQ-RETRY/coordination")).body.rounds[0]; }
async function restart() { await server!.app.close(); server!.index.close(); server = await buildApp({ root }); }
async function workerCalls() { return Number(await readFile(join(root, ".goal-worker-calls"), "utf8")); }
const command = (round_id: string) => "/requirements/REQ-RETRY/coordination/" + round_id + "/retry-goal";

async function configure(always_fail = false) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [worker, ...(always_fail ? ["--always-fail"] : []), "{{prompt}}"] },
    supervisor: { kind: "headless", bin: process.execPath, args: [supervisor, "{{prompt}}"] },
  } }));
}
async function prepare(max_attempts = 1) {
  await configure();
  server = await buildApp({ root });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-retry" }, spec: { nodes: [
    { id: "intake", artifact: "prd.md" },
    { id: "deliver", artifact: "review.md", depends_on: ["intake"], run: { agent: "worker", goal: {
      inputs: ["value.txt"], max_attempts, no_progress_limit: 1, timeout_ms: 20000, supervisor_agent: "supervisor", supervisor_timeout_ms: 5000,
      checks: [{ id: "value-test", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed') process.exit(1)"], timeout_ms: 2000 }],
    } }, gates: [{ id: "human-review", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "verification-passed", with: { verification_id: "value-test" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["deliver"] },
  ] } });
  expect((await api("POST", "/sdlcs/goal-retry/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-RETRY", title: "Goal 人工处理后继续", prd: "# Goal\n将 value.txt 改为 fixed，交付自测证据与 review 指南。" })).status).toBe(201);
  const response = await api("POST", "/requirements/REQ-RETRY/runs", { sdlc_id: "goal-retry" });
  expect(response.status).toBe(202);
  await waitFor(async () => (await round())?.status === "ok" && !server!.runs.isActive("REQ-RETRY"));
  return { run_id: response.body.run.run_id as string, round: await round() };
}
async function answer() {
  const current = await round();
  expect((await api("POST", "/requirements/REQ-RETRY/coordination/" + current.round_id + "/answer", { choice: "补充事实" })).status).toBe(200);
  const updated = await round();
  return { view: updated, input: { answer_event_id: updated.answer.event_id, input_hash: updated.goal_retry.input_hash } };
}

async function interruptedRetry(max_attempts = 1) {
  await prepare(max_attempts); const { view, input } = await answer();
  const original = server!.runs.start.bind(server!.runs);
  const start = vi.spyOn(server!.runs, "start").mockImplementation(async (req_id, id, version, guard) => original(req_id, id, version, {
    ...guard!, record: async (session, run_id) => { await guard!.record(session, run_id); throw Error("授权后中断，未派发"); },
  }));
  try { expect((await api("POST", command(view.round_id), input)).status).toBe(500); }
  finally { start.mockRestore(); }
  return (await facts()).find(event => event.type === "goal.retry.authorized")!.payload["run_id"] as string;
}

async function holdWorkspace() {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [worker, "{{prompt}}"] },
    supervisor: { kind: "headless", bin: process.execPath, args: [supervisor, "{{prompt}}"] },
    holder: { kind: "headless", bin: process.execPath, args: [lease_holder, "--mode", "claude", "--no-tools", "{{prompt}}"] },
  } }));
  await server!.agents.reload();
  await server!.sdlcs.publish("workspace-holder", stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "workspace-holder" }, spec: { nodes: [
    { id: "hold", artifact: "review.md", run: { agent: "holder" }, gates: [{ id: "human", role: {}, attach: { node: "hold", when: "post" },
      checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } }));
  expect((await api("POST", "/requirements", { req_id: "REQ-HOLDER", title: "占用工作区" })).status).toBe(201);
  const started = await api("POST", "/requirements/REQ-HOLDER/runs", { sdlc_id: "workspace-holder" });
  expect(started.status).toBe(202);
  await waitFor(async () => (await api("GET", "/requirements/REQ-HOLDER/approvals")).body.approvals.length === 1);
  return started.body.run.run_id as string;
}

describe("人工授权 Goal 续跑", () => {
  it("固定节点恢复只接受原授权节点，错误节点不落事实或调用 worker", async () => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const before = await workerCalls();
    const human_events = (await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited").map(event => event.event_id);
    expect((await api("POST", url, { input_hash: recovery.input_hash, node_id: "other-node" })).status).toBe(409);
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(0);
    expect(await workerCalls()).toBe(before);
    expect((await api("POST", url, { input_hash: recovery.input_hash, node_id: recovery.node_id })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const request = (await facts()).find(event => event.type === "goal.recovery.requested")!;
    expect(request.payload["node_id"]).toBe(recovery.node_id);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
    expect((await api("POST", url, { input_hash: recovery.input_hash, node_id: "other-node" })).status).toBe(409);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited").map(event => event.event_id)).toEqual(human_events);
  });

  it("工作区占用拒绝 Goal 恢复且不落恢复请求，释放后同 token 可续跑", async () => {
    const run_id = await interruptedRetry();
    const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const holder = await holdWorkspace();
    const rejected = await api("POST", url, { input_hash: recovery.input_hash });
    expect(rejected.status).toBe(409);
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(0);
    expect(await workerCalls()).toBe(1);
    await server!.runs.cancel(holder);
    expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
  });

  it("工作区占用拒绝新 Goal 授权，不登记半成品启动或扩预算", async () => {
    await prepare(); const { view, input } = await answer();
    const holder = await holdWorkspace();
    expect((await api("POST", command(view.round_id), input)).status).toBe(409);
    expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(1);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(0);
    await server!.runs.cancel(holder);
    expect((await api("POST", command(view.round_id), input)).status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2);
  });

  it("公开恢复入口在配置还原后继续同 run/审批，不重授预算", async () => {
    await prepare(); const { view, input } = await answer(); const response = await api("POST", command(view.round_id), input);
    const run_id = response.body.run.run_id; const url = "/runs/" + run_id + "/goal-recovery";
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const approval = (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0];
    await configure(true); await restart();
    expect((await api("GET", url)).body.recovery.available).toBe(false);
    await configure(); await server!.agents.reload();
    const recovery = (await api("GET", url)).body.recovery;
    expect(recovery).toMatchObject({ available: true, ready_current: true, remaining_attempts: 0, run_id });
    const restored = await api("POST", url, { input_hash: recovery.input_hash });
    expect(restored.status, JSON.stringify(restored.body)).toBe(202); expect(restored.body.run.run_id).toBe(run_id);
    expect(restored.body.run.status).toBe("waiting_human"); expect(await workerCalls()).toBe(2);
    expect(restored.body.run).toMatchObject({ error: null, finished_at: null });
    expect((await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0].approval_id).toBe(approval.approval_id);
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(1);
    expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(2);
    expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202);
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(1);
    const recovery_events = await facts(); const request = readGoalRecoveryRequest(recovery_events, run_id)!;
    for (const change of [
      { actor: { kind: "agent", id: "worker" } }, { source: { adapter: "worker" } }, { correlation_id: ulid() },
      { payload: { ...request.event.payload, authorization_event_id: ulid() } },
      { payload: { ...request.event.payload, checkpoint_event_id: null } },
      { payload: { ...request.event.payload, prior_request_event_id: ulid() } },
      { payload: { ...request.event.payload, node_input_hash: "a".repeat(64) } },
    ]) expect(() => readGoalRecoveryRequest(recovery_events.map(event => event.event_id === request.event.event_id ? { ...event, ...change } as EventEnvelope : event), run_id)).toThrow();
    await restart(); expect(await workerCalls()).toBe(2);
  });

  it("恢复写失败不派发；同 token 并发只记录一次请求，重放不重复调用", async () => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    expect(recovery).toMatchObject({ available: true, remaining_attempts: 1, deadline_at: null, ready_current: false });
    const session = await server!.sessions.open("REQ-RETRY"); const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      if (draft.type === "goal.recovery.requested") throw Error("恢复请求 fsync 失败"); return original(draft);
    });
    try { expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(500); }
    finally { append.mockRestore(); }
    expect(await workerCalls()).toBe(1); expect(server!.runs.isActive("REQ-RETRY")).toBe(false);
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(0);
    const responses = await Promise.all([api("POST", url, { input_hash: recovery.input_hash }, "recover-a"), api("POST", url, { input_hash: recovery.input_hash }, "recover-b")]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2); expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(1);
    expect((await api("POST", url, { input_hash: recovery.input_hash }, "recover-a")).body).toEqual(responses[0]!.body);
    expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
  });

  it.each([false, true])("恢复请求落盘后中断且输入变化=%s，冷恢复只派发有效原请求", async changed => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const old_value = await readFile(join(root, "value.txt"), "utf8");
    const session = await server!.sessions.open("REQ-RETRY"); const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await original(draft); if (draft.type === "goal.recovery.requested") throw Error("恢复请求已落盘，模拟中断"); return result;
    });
    try { expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(500); }
    finally { append.mockRestore(); }
    if (changed) await writeFile(join(root, "value.txt"), "changed-after-request");
    await restart();
    if (changed) {
      expect(await workerCalls()).toBe(1); expect((await server!.runs.getRun(run_id)).status).toBe("failed");
      await writeFile(join(root, "value.txt"), old_value);
      const current = (await api("GET", url)).body.recovery;
      expect(current.available).toBe(true); expect(current.input_hash).not.toBe(recovery.input_hash);
      expect((await api("POST", url, { input_hash: current.input_hash })).status).toBe(202);
    }
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2); expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(2);
    expect(readGoalRecoveryRequest(await facts(), run_id)?.consumed).toBe(true);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("旧恢复 token/未授权/取消/非当前 run 拒绝，已归档版本仍可恢复原授权", async () => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const session = await server!.sessions.open("REQ-RETRY"); const prd = await readFile(join(session.dir, "prd.md"), "utf8");
    await writeFile(join(session.dir, "prd.md"), prd + "\n变更目标");
    expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(409);
    expect(await workerCalls()).toBe(1);
    await writeFile(join(session.dir, "prd.md"), prd);
    const latest = (await api("GET", url)).body.recovery;
    await server!.sdlcs.archive("goal-retry", 1);
    expect((await api("POST", url, { input_hash: latest.input_hash })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const missing = await api("GET", "/runs/" + ulid() + "/goal-recovery"); expect(missing.status).toBe(404);
    const original_id = (await facts()).find(event => event.type === "goal.retry.authorized")!.payload["failed_run_id"] as string;
    expect((await api("POST", "/runs/" + original_id + "/goal-recovery", { input_hash: "a".repeat(64) })).status).toBe(409);
    await server!.runs.cancel(run_id);
    expect((await api("GET", url)).body.recovery.available).toBe(false);
  });

  it("有效 ready 可超时后恢复人审，但 stale ready 的耗尽预算和 blocked 不能恢复", async () => {
    await prepare(); const { view, input } = await answer(); const retry = await api("POST", command(view.round_id), input);
    const run_id = retry.body.run.run_id; const url = "/runs/" + run_id + "/goal-recovery";
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    await configure(true); await restart(); await configure(); await server!.agents.reload();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60000);
    try {
      expect((await api("GET", url)).body.recovery).toMatchObject({ available: true, ready_current: true, remaining_attempts: 0 });
      await writeFile(join(root, "value.txt"), "stale-ready");
      const stale = (await api("GET", url)).body.recovery;
      expect(stale.available).toBe(false); expect(stale.reason).toContain("预算");
      expect((await api("POST", url, { input_hash: "a".repeat(64) })).status).toBe(409);
    } finally { clock.mockRestore(); }
    expect(await workerCalls()).toBe(2);
  });

  it("typed client 通过真实 HTTP 恢复同 run，幂等重放、输入约束和错误均透传", async () => {
    const run_id = await interruptedRetry();
    await server!.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server!.app.server.address(); if (address === null || typeof address === "string") throw Error("没有监听端口");
    const client = createClient("http://127.0.0.1:" + address.port);
    const recovery = (await client.getGoalRecovery(run_id)).recovery;
    await expect(client.recoverGoal(run_id, "a".repeat(64))).rejects.toMatchObject({ status: 409 });
    const response = await client.recoverGoal(run_id, recovery.input_hash!, "typed-recovery");
    expect((await client.recoverGoal(run_id, recovery.input_hash!, "typed-recovery"))).toEqual(response);
    expect(response.run.run_id).toBe(run_id);
    await waitFor(async () => (await client.getApprovals("REQ-RETRY")).approvals.length === 1);
    expect((await client.getRequirement("REQ-RETRY")).requirement.goal_recovery?.available).toBe(false);
    expect(await workerCalls()).toBe(2);
    await expect(client.getGoalRecovery(ulid())).rejects.toMatchObject({ status: 404 });
  });

  it("恢复记录前配置漂移拒绝，记录后热重载仍执行固定配置", async () => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const original = server!.runs.readNodeInput.bind(server!.runs); let switched = false;
    const read = vi.spyOn(server!.runs, "readNodeInput").mockImplementation(async (...args) => {
      const input = await original(...args); if (!switched) { switched = true; await configure(true); await server!.agents.reload(); } return input;
    });
    try { expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(409); }
    finally { read.mockRestore(); }
    expect((await facts()).filter(event => event.type === "goal.recovery.requested")).toHaveLength(0); expect(await workerCalls()).toBe(1);
    await configure(); await server!.agents.reload();
    const session = await server!.sessions.open("REQ-RETRY"); const original_append = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await original_append(draft); if (draft.type === "goal.recovery.requested") { await configure(true); await server!.agents.reload(); } return event;
    });
    try { expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202); }
    finally { append.mockRestore(); }
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2);
  });

  it("已有尝试的恢复保留原 deadline 与剩余次数，索引删除不重复 worker", async () => {
    const run_id = await interruptedRetry(3); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const session = await server!.sessions.open("REQ-RETRY"); const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await original(draft); if (draft.type === "goal.attempt.started" && draft.payload["run_id"] === run_id) throw Error("尝试已开始，派发前中断"); return event;
    });
    try {
      expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202);
      await waitFor(async () => !server!.runs.isActive("REQ-RETRY"));
    } finally { append.mockRestore(); }
    expect(await workerCalls()).toBe(1);
    const current = (await api("GET", url)).body.recovery;
    expect(current).toMatchObject({ available: true, remaining_attempts: 2, ready_current: false });
    const deadline = current.deadline_at;
    expect((await api("POST", url, { input_hash: current.input_hash })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const attempts = (await facts()).filter(event => event.type === "goal.attempt.started" && event.payload["run_id"] === run_id);
    expect(attempts.map(event => event.payload["attempt"])).toEqual([1, 2]); expect(await workerCalls()).toBe(2);
    await server!.app.close(); server!.index.close(); server = undefined;
    await rm(join(root, "cord", ".index"), { recursive: true, force: true }); server = await buildApp({ root });
    expect(await workerCalls()).toBe(2);
    expect((await api("GET", url)).body.recovery.deadline_at).toBe(deadline);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
  });

  it("已消费恢复不能使 blocked Goal 自动循环，坏恢复请求冷启动 fail-closed", async () => {
    const run_id = await interruptedRetry(); const url = "/runs/" + run_id + "/goal-recovery";
    const recovery = (await api("GET", url)).body.recovery;
    const session = await server!.sessions.open("REQ-RETRY"); const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await original(draft); if (draft.type === "goal.recovery.requested") await writeFile(join(root, ".goal-worker-calls"), "0"); return event;
    });
    try { expect((await api("POST", url, { input_hash: recovery.input_hash })).status).toBe(202); }
    finally { append.mockRestore(); }
    await waitFor(async () => !server!.runs.isActive("REQ-RETRY"));
    expect((await api("GET", url)).body.recovery.reason).toContain("阻塞");
    const calls = await workerCalls(); await restart(); expect(await workerCalls()).toBe(calls);
    expect((await api("POST", url, { input_hash: "a".repeat(64) })).status).toBe(409);
    const events = await facts(); await server!.app.close(); server!.index.close(); server = undefined;
    await writeFile(join(session.dir, "events.jsonl"), events.map(event => JSON.stringify(event.type === "goal.recovery.requested" ? { ...event, source: { adapter: "agent" } } : event)).join("\n") + "\n");
    server = await buildApp({ root }); expect(await workerCalls()).toBe(calls);
    expect((await server.runs.getRun(run_id)).error).toContain("恢复请求");
  });

  it("A/B/A 重载窗口中，校验与派发始终使用同一配置", async () => {
    await prepare(); const { view, input } = await answer();
    const authorized_hash = server!.agents.resolver()("worker").configuration_hash;
    const read_input = server!.runs.readNodeInput.bind(server!.runs);
    let switched = false;
    const read = vi.spyOn(server!.runs, "readNodeInput").mockImplementation(async (...args) => {
      const result = await read_input(...args);
      if (!switched) { switched = true; await configure(true); await server!.agents.reload(); }
      return result;
    });
    const real_start = server!.runs.start.bind(server!.runs);
    const start = vi.spyOn(server!.runs, "start").mockImplementation(async (...args) => {
      await configure(); await server!.agents.reload();
      return real_start(...args);
    });
    try {
      const response = await api("POST", command(view.round_id), input);
      if (response.status === 409) {
        expect(await workerCalls()).toBe(1);
        expect((await facts()).some(event => event.type === "goal.retry.authorized")).toBe(false);
        return;
      }
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await waitFor(async () => (await facts()).some(event => event.type === "goal.attempt.completed" && event.payload["run_id"] === response.body.run.run_id));
      const task = (await facts()).find(event => event.type === "agent.task.started" && event.payload["run_id"] === response.body.run.run_id)!;
      expect(task.payload["agent_configuration_hash"]).toBe(authorized_hash);
      expect((await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals).toHaveLength(1);
    } finally { read.mockRestore(); start.mockRestore(); }
  });

  it("授权记录前重载使旧 token 失效；授权后的重载不替换固定 worker", async () => {
    await prepare(); const { view, input } = await answer();
    const original = server!.runs.start.bind(server!.runs);
    const wrap = (after: boolean) => vi.spyOn(server!.runs, "start").mockImplementation(async (req_id, id, version, guard) => original(req_id, id, version, {
      ...guard!, record: async (session, run_id) => {
        if (after) await guard!.record(session, run_id);
        await configure(true); await server!.agents.reload();
        if (!after) await guard!.record(session, run_id);
      },
    }));
    const before = wrap(false);
    try { expect((await api("POST", command(view.round_id), input)).status).toBe(409); }
    finally { before.mockRestore(); }
    expect(await workerCalls()).toBe(1);
    await configure(); await server!.agents.reload();
    const current = await round(); const after = wrap(true);
    try {
      const response = await api("POST", command(view.round_id), { ...input, input_hash: current.goal_retry.input_hash });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
      const events = await facts(); const auth = readGoalRetryAuthorization(events, response.body.run.run_id)!;
      const task = events.find(event => event.type === "agent.task.started" && event.payload["run_id"] === response.body.run.run_id)!;
      expect(task.payload["agent_configuration_hash"]).toBe(auth.payload["agent_configuration_hash"]);
      expect(task.payload["agent_configuration_hash"]).not.toBe(server!.agents.resolver()("worker").configuration_hash);
      expect(events.filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    } finally { after.mockRestore(); }
  });

  it("冷配置漂移拒绝审批和派发，还原后恢复原 run 与有效交付", async () => {
    await prepare(); const { view, input } = await answer();
    const response = await api("POST", command(view.round_id), input);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const approval = (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0];
    const auth = readGoalRetryAuthorization(await facts(), response.body.run.run_id)!;
    await configure(true); await restart();
    expect((await server!.runs.getRun(response.body.run.run_id)).status).toBe("failed"); expect(await workerCalls()).toBe(2);
    expect((await api("POST", "/requirements/REQ-RETRY/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] })).status).toBe(409);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await configure(); await server!.agents.reload(); await server!.runs.recover(response.body.run.run_id);
    expect((await server!.runs.getRun(response.body.run.run_id)).status).toBe("waiting_human");
    expect((await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0].approval_id).toBe(approval.approval_id);
    expect(await workerCalls()).toBe(2); expect(readGoalRetryAuthorization(await facts(), response.body.run.run_id)?.event_id).toBe(auth.event_id);
    expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(2);
    expect((await api("POST", "/requirements/REQ-RETRY/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] })).status).toBe(200);
    await waitFor(async () => (await server!.runs.getRun(response.body.run.run_id)).status === "completed");
    expect(await workerCalls()).toBe(2);
  });

  it.each(["value", "answer"])("首次派发前 %s 输入变化拒绝恢复，恢复相同输入可继续原授权", async change => {
    await prepare(); const { view, input } = await answer();
    const original = server!.runs.start.bind(server!.runs);
    const start = vi.spyOn(server!.runs, "start").mockImplementation(async (req_id, id, version, guard) => original(req_id, id, version, {
      ...guard!, record: async (session, run_id) => { await guard!.record(session, run_id); throw Error("模拟授权后进程中断"); },
    }));
    try { expect((await api("POST", command(view.round_id), input)).status).toBe(500); }
    finally { start.mockRestore(); }
    const auth = (await facts()).find(event => event.type === "goal.retry.authorized")!; const run_id = auth.payload["run_id"] as string;
    const old_value = await readFile(join(root, "value.txt"), "utf8");
    if (change === "value") await writeFile(join(root, "value.txt"), "new-input");
    else await api("POST", "/requirements/REQ-RETRY/coordination/" + view.round_id + "/answer/revoke", { answer_event_id: input.answer_event_id });
    server!.index.setRunStatus(run_id, "running"); await restart();
    expect(await workerCalls()).toBe(1); expect((await server!.runs.getRun(run_id)).status).toBe("failed");
    expect((await server!.runs.getRun(run_id)).error).toContain("输入");
    if (change === "answer") return;
    await writeFile(join(root, "value.txt"), old_value); await server!.runs.recover(run_id);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2); expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(2);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
  });

  it("冷旧审批依据变化时仅重检原授权 run，不创建新的 Goal 预算", async () => {
    await prepare(); const { view, input } = await answer(); const response = await api("POST", command(view.round_id), input);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const approval = (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0]; await restart();
    await writeFile(join(root, "value.txt"), "stale-review");
    const start = vi.spyOn(server!.runs, "start");
    try { expect((await api("POST", "/requirements/REQ-RETRY/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] })).status).toBe(409); expect(start).not.toHaveBeenCalled(); }
    finally { start.mockRestore(); }
    await waitFor(async () => !server!.runs.isActive("REQ-RETRY"));
    expect(await workerCalls()).toBe(2); expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(2);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await server!.runs.getRun(response.body.run.run_id)).run_id).toBe(response.body.run.run_id);
    expect((await facts()).filter(event => event.type === "goal.attempt.started" && event.payload["run_id"] === response.body.run.run_id)).toHaveLength(1);
  });

  it.each([true, false])("冷旧授权 worker 来源存在=%s，兼容恢复必须有可证明的身份", async has_task => {
    await prepare(); const { view, input } = await answer();
    let run_id: string;
    if (has_task) {
      const response = await api("POST", command(view.round_id), input); run_id = response.body.run.run_id;
      await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    } else {
      const original = server!.runs.start.bind(server!.runs);
      const start = vi.spyOn(server!.runs, "start").mockImplementation(async (req_id, id, version, guard) => original(req_id, id, version, {
        ...guard!, record: async (session, id) => { await guard!.record(session, id); throw Error("模拟旧授权后中断"); },
      }));
      try { expect((await api("POST", command(view.round_id), input)).status).toBe(500); }
      finally { start.mockRestore(); }
      run_id = (await facts()).find(event => event.type === "goal.retry.authorized")!.payload["run_id"] as string;
      server!.index.setRunStatus(run_id, "running");
    }
    const events = await facts(); const session = await server!.sessions.open("REQ-RETRY");
    await server!.app.close(); server!.index.close(); server = undefined;
    await writeFile(join(session.dir, "events.jsonl"), events.map(event => {
      if (event.type !== "goal.retry.authorized") return JSON.stringify(event);
      const { agent_configuration_hash, supervisor_configuration_hash, node_input_hash, ...payload } = event.payload;
      return JSON.stringify({ ...event, payload });
    }).join("\n") + "\n");
    server = await buildApp({ root });
    expect(await workerCalls()).toBe(has_task ? 2 : 1);
    expect((await server.runs.getRun(run_id)).status).toBe(has_task ? "waiting_human" : "failed");
    if (!has_task) expect((await server.runs.getRun(run_id)).error).toContain("配置身份");
  });

  it("旧授权必须有因果合法的首条任务身份，部分身份字段和坏来源拒绝", async () => {
    await prepare(); const { view, input } = await answer(); const response = await api("POST", command(view.round_id), input);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const events = await facts(); const auth = readGoalRetryAuthorization(events, response.body.run.run_id)!;
    const { agent_configuration_hash, supervisor_configuration_hash, node_input_hash, ...legacy } = auth.payload;
    expect(GoalRetryAuthorizedPayloadSchema.safeParse(legacy).success).toBe(true);
    for (const group of [{ agent_configuration_hash }, { supervisor_configuration_hash, node_input_hash }]) expect(GoalRetryAuthorizedPayloadSchema.safeParse({ ...legacy, ...group }).success).toBe(false);
    const old_events = events.map(event => event.event_id === auth.event_id ? { ...event, payload: legacy } : event);
    const node = (await server!.sdlcs.get("goal-retry", 1)).def.spec.nodes.find(node => node.id === "deliver")!;
    expect(readGoalRetryAgentIdentity(old_events, response.body.run.run_id, node)).toMatchObject({ configuration_hash: agent_configuration_hash, worker_started: true });
    const tasks = events.filter(event => ["agent.task.started", "agent.task.completed"].includes(event.type) && event.payload["run_id"] === response.body.run.run_id);
    expect(() => readGoalRetryAgentIdentity(old_events.filter(event => !tasks.includes(event)), response.body.run.run_id, node)).toThrow(/配置身份/);
    for (const change of [
      { actor: { kind: "agent", id: "worker" } }, { source: { adapter: "worker" } }, { seq: auth.seq }, { session_id: "REQ-OTHER" },
      { payload: { ...tasks[0]!.payload, agent_configuration_hash: undefined } },
      { payload: { ...tasks[0]!.payload, workflow_revision: "b".repeat(64) } },
    ]) expect(() => readGoalRetryAgentIdentity(old_events.map(event => event.event_id === tasks[0]!.event_id ? { ...event, ...change } as EventEnvelope : event), response.body.run.run_id, node)).toThrow();
    expect(() => readGoalRetryAgentIdentity(events.map(event => event.event_id === auth.event_id ? { ...event, payload: { ...event.payload, agent_configuration_hash: "b".repeat(64) } } : event), response.body.run.run_id, node)).toThrow(/身份/);
  });

  it("答复只记录事实，独立授权新发布预算后修复并停在最终人审", async () => {
    const original = await prepare();
    expect(original.round.goal_retry).toMatchObject({ available: false, input_hash: null });
    const { view, input } = await answer();
    expect(view.goal_retry).toMatchObject({ available: true, max_attempts: 1, timeout_ms: 20000 });
    expect((await server!.runs.getRun(original.run_id)).status).toBe("failed"); expect(await workerCalls()).toBe(1);
    const response = await api("POST", command(view.round_id), input);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const run_id = response.body.run.run_id;
    expect(run_id).not.toBe(original.run_id);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2);
    expect((await api("GET", "/requirements/REQ-RETRY")).body.requirement.status).toBe("waiting_human");
    const events = await facts();
    const auth = readGoalRetryAuthorization(events, run_id)!;
    expect(auth.payload).toMatchObject({ failed_run_id: original.run_id, answer_event_id: input.answer_event_id, input_hash: input.input_hash, max_attempts: 1, timeout_ms: 20000 });
    expect(auth.actor.kind).toBe("human");
    expect(events.find(event => event.type === "agent.task.started" && event.payload["run_id"] === run_id)!.seq).toBeGreaterThan(auth.seq);
    expect(events.filter(event => event.type === "workflow.node.exited" && event.payload["node_id"] === "intake")).toHaveLength(1);
    expect(events.filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect(events.filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    expect(await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).toContain("补充事实");
    const approval = (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0];
    await restart(); expect(await workerCalls()).toBe(2);
    expect((await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0].approval_id).toBe(approval.approval_id);
    expect((await round()).goal_retry).toMatchObject({ available: false, run_id });
  });

  it("同依据、不同幂等键并发只授权一次；重复命令重放，改输入拒绝", async () => {
    await prepare(); const { view, input } = await answer();
    const results = await Promise.all([api("POST", command(view.round_id), input), api("POST", command(view.round_id), input)]);
    expect(results.map(result => result.status)).toEqual([202, 202]);
    expect(results[0].body.run.run_id).toBe(results[1].body.run.run_id);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
    expect((await api("POST", command(view.round_id), { ...input, input_hash: "a".repeat(64) })).status).toBe(409);
    await restart(); const replay = await api("POST", command(view.round_id), input);
    expect(replay.status).toBe(202); expect(replay.body.run.run_id).toBe(results[0].body.run.run_id);
  });

  it("源码或事实变化使旧 token 失效，刷新后可明确授权最新输入", async () => {
    await prepare(); const { view, input } = await answer();
    await writeFile(join(root, "value.txt"), "fixed-manually");
    expect((await api("POST", command(view.round_id), input)).status).toBe(409);
    const current = await round(); expect(current.goal_retry.input_hash).not.toBe(input.input_hash);
    expect((await api("POST", command(view.round_id), { answer_event_id: input.answer_event_id, input_hash: current.goal_retry.input_hash })).status).toBe(202);
  });

  it("撤回答复后不能继续，缺少答复或伪造答复不能授权", async () => {
    const original = await prepare();
    expect((await api("POST", command(original.round.round_id), { answer_event_id: ulid(), input_hash: "a".repeat(64) })).status).toBe(409);
    const { view, input } = await answer();
    expect((await api("POST", command(view.round_id), { ...input, answer_event_id: ulid() })).status).toBe(409);
    expect((await api("POST", "/requirements/REQ-RETRY/coordination/" + view.round_id + "/answer/revoke", { answer_event_id: input.answer_event_id })).status).toBe(200);
    expect((await api("POST", command(view.round_id), input)).status).toBe(409);
    expect((await round()).goal_retry.available).toBe(false);
    expect((await facts()).some(event => event.type === "goal.retry.authorized")).toBe(false);
  });

  it("预留运行槽位前与授权记录前都重新核验输入变化", async () => {
    await prepare(); const { view, input } = await answer();
    const original = server!.runs.start.bind(server!.runs);
    const start = vi.spyOn(server!.runs, "start").mockImplementation(async (req_id, id, version, guard) => {
      const wrapped: RunStartGuard = { ...guard!, record: async (session, run_id) => { await writeFile(join(root, "value.txt"), "LATE_CHANGE"); await guard!.record(session, run_id); } };
      return original(req_id, id, version, wrapped);
    });
    try { expect((await api("POST", command(view.round_id), input)).status).toBe(409); }
    finally { start.mockRestore(); }
    expect(await workerCalls()).toBe(1); expect((await facts()).some(event => event.type === "goal.retry.authorized")).toBe(false);
    await restart(); expect(await workerCalls()).toBe(1);
  });

  it("授权写失败不派发，冷恢复不把缺授权的 started 当有效预算", async () => {
    await prepare(); const { view, input } = await answer();
    const session = await server!.sessions.open("REQ-RETRY"); const real_append = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => { if (draft.type === "goal.retry.authorized") throw Error("authorization fsync failure"); return real_append(draft); });
    try { expect((await api("POST", command(view.round_id), input)).status).toBe(500); }
    finally { append.mockRestore(); }
    expect(await workerCalls()).toBe(1); await restart(); expect(await workerCalls()).toBe(1);
    expect((await facts()).some(event => event.type === "goal.retry.authorized")).toBe(false);
    const repaired = await round(); expect(repaired.goal_retry.available).toBe(true);
    const retry = await api("POST", command(view.round_id), { answer_event_id: input.answer_event_id, input_hash: repaired.goal_retry.input_hash });
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect(await workerCalls()).toBe(2);
  });

  it("归档和额外预算参数拒绝重新执行", async () => {
    await prepare(); const { view, input } = await answer();
    expect((await api("POST", command(view.round_id), { ...input, max_attempts: 10 })).status).toBe(400);
    await server!.sdlcs.archive("goal-retry", 1);
    expect((await api("POST", command(view.round_id), input)).status).toBe(409);
  });

  it("原 run 被其他人工启动替代后，不能再使用旧答复授权", async () => {
    await prepare(); const { view, input } = await answer();
    await server!.runs.start("REQ-RETRY", "goal-retry", 1);
    expect((await api("POST", command(view.round_id), input)).status).toBe(409);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(0);
  });

  it("索引删除后从启动和授权事实重建预算来源，不重复有效交付", async () => {
    await prepare(); const { view, input } = await answer();
    const response = await api("POST", command(view.round_id), input); expect(response.status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const approval = (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0];
    await server!.app.close(); server!.index.close(); server = undefined;
    await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    server = await buildApp({ root });
    expect(await workerCalls()).toBe(2);
    expect((await server.runs.getRun(response.body.run.run_id)).goal_retry_round_id).toBe(view.round_id);
    const original_run_id = (await facts()).find(event => event.type === "goal.retry.authorized")!.payload["failed_run_id"] as string;
    expect((await server.runs.getRun(original_run_id)).status).toBe("failed");
    expect((await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals[0].approval_id).toBe(approval.approval_id);
    expect((await api("POST", command(view.round_id), input)).body.run.run_id).toBe(response.body.run.run_id);
  });

  it("坏授权引用/actor/重复事实被拒绝，不能恢复为有效人工预算", async () => {
    await prepare(); const { view, input } = await answer();
    const response = await api("POST", command(view.round_id), input); expect(response.status).toBe(202);
    const run_id = response.body.run.run_id;
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    const events = await facts(); const auth = readGoalRetryAuthorization(events, run_id)!;
    for (const change of [
      { actor: { kind: "agent", id: "worker" } },
      { correlation_id: ulid() },
      { payload: { ...auth.payload, answer_event_id: ulid() } },
      { payload: { ...auth.payload, failed_run_id: ulid() } },
      { payload: { ...auth.payload, goal_event_id: ulid() } },
    ]) expect(() => readGoalRetryAuthorization(events.map(event => event.event_id === auth.event_id ? { ...event, ...change } as EventEnvelope : event), run_id)).toThrow();
    expect(() => readGoalRetryAuthorization([...events, { ...auth, event_id: ulid() }], run_id)).toThrow(/重复/);
    expect(() => readGoalRetryAuthorization([...events.filter(event => event.event_id !== auth.event_id), auth], run_id)).toThrow(/来源不一致/);
    const session = await server!.sessions.open("REQ-RETRY");
    await server!.app.close(); server!.index.close(); server = undefined;
    const body = events.map(event => event.event_id === auth.event_id ? { ...event, payload: { ...event.payload, max_attempts: 9 } } : event);
    await writeFile(join(session.dir, "events.jsonl"), body.map(event => JSON.stringify(event)).join("\n") + "\n");
    server = await buildApp({ root });
    expect(await workerCalls()).toBe(2);
    expect((await server.runs.getRun(run_id)).status).toBe("failed");
    expect((await server.runs.getRun(run_id)).error).toContain("授权");
  });

  it("授权后撤回答复保留审计，已启动 run 不自动取消", async () => {
    await prepare(); const { view, input } = await answer();
    const response = await api("POST", command(view.round_id), input); expect(response.status).toBe(202);
    await waitFor(async () => (await api("GET", "/requirements/REQ-RETRY/approvals")).body.approvals.length === 1);
    expect((await api("POST", "/requirements/REQ-RETRY/coordination/" + view.round_id + "/answer/revoke", { answer_event_id: input.answer_event_id })).status).toBe(200);
    expect(readGoalRetryAuthorization(await facts(), response.body.run.run_id)).not.toBeNull();
    expect((await api("GET", "/requirements/REQ-RETRY")).body.requirement.status).toBe("waiting_human");
  });
});
