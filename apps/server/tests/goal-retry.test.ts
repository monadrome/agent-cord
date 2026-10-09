import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGoalRetryAuthorization, type EventEnvelope } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { RunStartGuard } from "../src/services/run-service.js";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-supervisor.mjs", import.meta.url));
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

async function prepare() {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [worker, "{{prompt}}"] },
    supervisor: { kind: "headless", bin: process.execPath, args: [supervisor, "{{prompt}}"] },
  } }));
  server = await buildApp({ root });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-retry" }, spec: { nodes: [
    { id: "intake", artifact: "prd.md" },
    { id: "deliver", artifact: "review.md", depends_on: ["intake"], run: { agent: "worker", goal: {
      inputs: ["value.txt"], max_attempts: 1, no_progress_limit: 1, timeout_ms: 20000, supervisor_agent: "supervisor", supervisor_timeout_ms: 5000,
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

describe("人工授权 Goal 续跑", () => {
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
