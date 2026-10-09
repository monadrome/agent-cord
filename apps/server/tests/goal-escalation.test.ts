import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalBlockerTriggerSchema } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-supervisor.mjs", import.meta.url));
const manual_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
let root: string;
let server: BuiltServer | undefined;
let sequence = 0;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-goal-escalation-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });

async function api(method: "GET" | "POST", url: string, body?: unknown) {
  const response = await server!.app.inject({ method, url: "/api/v1" + url,
    ...(method === "POST" ? { headers: { "idempotency-key": "goal-escalation-" + sequence++ } } : {}), ...(body === undefined ? {} : { payload: body }) });
  return { status: response.statusCode, body: response.json() };
}
async function waitFor(check: () => Promise<boolean>) { const deadline = Date.now() + 12_000; while (!await check()) { if (Date.now() > deadline) throw new Error("自动 Goal 升级等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function rounds() { return (await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).body.rounds; }
async function events() { return (await server!.sessions.open("REQ-GOAL-ESC")).events.readOrdered(); }
async function restart() { await server!.app.close(); server!.index.close(); server = await buildApp({ root }); }
async function calls() { return Number(await readFile(join(root, ".goal-supervisor-calls"), "utf8")); }
async function context() {
  const run = await server!.runs.latestRun("REQ-GOAL-ESC");
  const binding = await server!.sdlcs.get("goal-escalation", 1);
  const blocker = (await events()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
  return { req_id: "REQ-GOAL-ESC", run_id: run!.run_id, sdlc_id: run!.sdlc_id, sdlc_version: run!.sdlc_version,
    workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, node_id: "deliver", goal_event_id: blocker.event_id, supervisor_agent: "supervisor" };
}

async function prepare(options: { protocol?: "headless" | "acp"; mode?: string; sleep?: number; supervisor_agent?: string | null; checks_pass?: boolean; supervisor_timeout_ms?: number } = {}) {
  const protocol = options.protocol ?? "headless";
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [worker, "{{prompt}}"] },
    supervisor: { kind: protocol, bin: process.execPath, args: [supervisor, ...(protocol === "acp" ? ["--acp"] : []), "--mode", options.mode ?? "ask", "--sleep", String(options.sleep ?? 0), ...(protocol === "headless" ? ["{{prompt}}"] : [])] },
  } }));
  server = await buildApp({ root });
  const supervisor_agent = options.supervisor_agent === undefined ? "supervisor" : options.supervisor_agent;
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-escalation" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], max_attempts: 1, no_progress_limit: 1,
      ...(supervisor_agent === null ? {} : { supervisor_agent, supervisor_timeout_ms: options.supervisor_timeout_ms ?? 5_000 }),
      checks: [{ id: "check", bin: process.execPath, args: ["-e", "process.exit(" + (options.checks_pass ? 0 : 3) + ")"], timeout_ms: 2_000 }] } },
      gates: [{ id: "human-review", role: { approvers: ["local-human"] }, attach: { node: "deliver", when: "post" }, checks: [{ ref: "verification-passed", with: { verification_id: "check" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["deliver"], gates: [] },
  ] } });
  const published = await api("POST", "/sdlcs/goal-escalation/versions/publish", { yaml });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-GOAL-ESC", title: "Goal blocker" })).status).toBe(201);
  const session = await server.sessions.open("REQ-GOAL-ESC");
  await writeFile(join(session.dir, "prd.md"), "# Goal blocker\n修复 value.txt 并验证。\n");
}
async function start() { const response = await api("POST", "/requirements/REQ-GOAL-ESC/runs", { sdlc_id: "goal-escalation" }); expect(response.status).toBe(202); return response.body.run.run_id as string; }

async function startManual(sleep_ms: number) {
  const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8"));
  const proposal = { summary: "等待当前 Goal", next_action: { kind: "wait", reason: "等待最新结果", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
  config.agents.manual = { kind: "headless", bin: process.execPath, args: [manual_fixture, "--mode", "claude", "--no-tools", "--sleep", String(sleep_ms), "--result-text", JSON.stringify(proposal), "{{prompt}}"] };
  await writeFile(file, stringify(config)); await server!.agents.reload();
  return server!.coordination.start("REQ-GOAL-ESC", { agent: "manual", sdlc_id: "goal-escalation", timeout_ms: 60_000 });
}

describe("Goal blocked 自动协调升级", () => {
  it.each(["headless", "acp"] as const)("%s supervisor 自动解释 blocker，冷恢复不重复调用，答复不等于批准", async protocol => {
    await prepare({ protocol }); const run_id = await start();
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    const round = (await rounds())[0];
    expect(round).toMatchObject({ trigger: "goal_blocked", run_id, node_id: "deliver", current: true, answerable: true, adoptable: false });
    expect(round.proposal.next_action.kind).toBe("ask_human");
    expect(round.proposal.next_action.evidence[0]).toEqual({ source: "goal", id: round.goal_event_id });
    const facts = await events(); const request = facts.find(event => event.type === "coordinator.round.requested")!;
    expect(request.actor).toEqual({ kind: "system", id: "goal-supervisor" });
    expect(await calls()).toBe(1);
    await expect(server!.coordination.start("REQ-GOAL-ESC", { agent: "supervisor", sdlc_id: "goal-escalation", sdlc_version: 1 },
      { run_id, node_id: "deliver", goal_event_id: round.goal_event_id })).rejects.toThrow(/已请求协调/);
    await restart();
    expect(await calls()).toBe(1); expect((await rounds())[0].round_id).toBe(round.round_id);
    expect((await api("POST", "/requirements/REQ-GOAL-ESC/coordination/" + round.round_id + "/answer", { choice: "补充事实" })).status).toBe(200);
    expect((await server!.runs.getRun(run_id)).status).toBe("failed");
    expect((await api("GET", "/requirements/REQ-GOAL-ESC/approvals")).body.approvals).toHaveLength(0);
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("成功 happy path 不启动额外协调", async () => {
    await prepare({ checks_pass: true }); await start();
    await waitFor(async () => (await api("GET", "/requirements/REQ-GOAL-ESC/approvals")).body.approvals.length === 1);
    expect(await rounds()).toHaveLength(0); await expect(calls()).rejects.toThrow();
  });

  it("未声明 supervisor 的 blocked Goal 保持旧流程", async () => {
    await prepare({ supervisor_agent: null }); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    expect(await rounds()).toHaveLength(0); await restart(); expect(await rounds()).toHaveLength(0);
  });

  it.each(["invalid", "advance", "missing-evidence"])("supervisor %s 输出拒绝且不修改 run 失败", async mode => {
    await prepare({ mode }); const run_id = await start();
    await waitFor(async () => (await rounds())[0]?.status === "failed");
    expect((await rounds())[0]).toMatchObject({ proposal: null, failure_stage: "output", answerable: false });
    expect((await server!.runs.getRun(run_id)).error).toContain("无进展");
    await restart(); expect(await calls()).toBe(1); expect(await rounds()).toHaveLength(1);
  });

  it("未知 supervisor 有明确失败轮次，重复恢复不会重复请求", async () => {
    await prepare({ supervisor_agent: "missing-supervisor" }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "failed");
    expect((await rounds())[0]).toMatchObject({ failure_stage: "configuration", trigger: "goal_blocked" });
    await restart(); expect(await rounds()).toHaveLength(1);
  });

  it("同 blocker 并发和冷恢复只补一次，追加失败不会伪记已请求", async () => {
    await prepare(); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    const trigger = await context();
    const session = await server!.sessions.open("REQ-GOAL-ESC"); const original = session.events.append.bind(session.events);
    const failure = vi.spyOn(session.events, "append").mockImplementation(async draft => { if (draft.type === "coordinator.round.requested") throw new Error("request fsync failure"); return original(draft); });
    await expect(server!.coordination.escalateGoalBlocker(trigger)).rejects.toThrow("request fsync failure"); failure.mockRestore();
    expect(await rounds()).toHaveLength(0);
    await Promise.all([server!.coordination.escalateGoalBlocker(trigger), server!.coordination.escalateGoalBlocker(trigger)]);
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    expect(await calls()).toBe(1); await restart(); expect(await rounds()).toHaveLength(1); expect(await calls()).toBe(1);
  });

  it("缺失请求的阻塞在 server 重启时自动补齐", async () => {
    await prepare(); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    expect(await rounds()).toHaveLength(0); await restart();
    await waitFor(async () => (await rounds())[0]?.status === "ok"); expect(await calls()).toBe(1);
  });

  it("协调过程中源码改变记 stale，旧问题不能答复", async () => {
    await prepare({ sleep: 800 }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "running");
    await writeFile(join(root, "value.txt"), "changed-input");
    await waitFor(async () => (await rounds())[0]?.status === "stale");
    expect((await rounds())[0].proposal).toBeNull(); await restart(); expect(await calls()).toBe(1);
  });

  it("自动轮次取消有终态，原 blocker 不因重启重复调用", async () => {
    await prepare({ sleep: 1000 }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "running"); const round = (await rounds())[0];
    expect((await api("POST", "/requirements/REQ-GOAL-ESC/coordination/" + round.round_id + "/cancel")).status).toBe(200);
    expect((await rounds())[0].status).toBe("cancelled"); await restart(); expect(await rounds()).toHaveLength(1);
  });

  it("supervisor 超时形成单次失败轮次，不改变原 run 或在重启时续加预算", async () => {
    await prepare({ sleep: 1000, supervisor_timeout_ms: 100 }); const run_id = await start();
    await waitFor(async () => (await rounds())[0]?.status === "timeout");
    expect((await rounds())[0]).toMatchObject({ proposal: null, trigger: "goal_blocked" });
    expect((await server!.runs.getRun(run_id)).status).toBe("failed");
    await restart(); expect(await rounds()).toHaveLength(1);
    expect((await events()).filter(event => event.type === "coordinator.round.started")).toHaveLength(1);
  });

  it("伪造 blocker 被拒绝，外部请求不能传入触发字段", async () => {
    await prepare(); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    const ctx = await context();
    await expect(server!.coordination.start("REQ-GOAL-ESC", { agent: "supervisor", sdlc_id: "goal-escalation", sdlc_version: 1 },
      GoalBlockerTriggerSchema.parse({ run_id, node_id: "deliver", goal_event_id: "01ARZ3NDEKTSV4RRFFQ69G5F00" }))).rejects.toThrow(/blocker 来源/);
    expect((await api("POST", "/requirements/REQ-GOAL-ESC/coordination", { agent: "supervisor", trigger: "goal_blocked", goal_event_id: ctx.goal_event_id })).status).toBe(400);
    expect(await rounds()).toHaveLength(0);
  });

  it("历史自动请求来源被改成不存在事件时查询拒绝，不能展示可答复问题", async () => {
    await prepare(); await start(); await waitFor(async () => (await rounds())[0]?.status === "ok");
    const session = await server!.sessions.open("REQ-GOAL-ESC");
    const original = session.events.readOrderedStrict!.bind(session.events);
    const mock = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => (await original()).map(event =>
      event.type === "coordinator.round.requested" ? { ...event, payload: { ...event.payload, goal_event_id: "01ARZ3NDEKTSV4RRFFQ69G5F00" } } : event));
    try { expect((await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).status).toBe(500); }
    finally { mock.mockRestore(); }
    expect((await rounds())[0].answerable).toBe(true);
  });

  it("已有人工协调时等待其收束，再核验并执行一次自动升级", async () => {
    await prepare(); const manual = await startManual(800); await start();
    await waitFor(async () => (await rounds()).some((round: any) => round.trigger === "goal_blocked" && round.status === "ok"));
    const list = await rounds(); expect(list).toHaveLength(2);
    expect(list.find((round: any) => round.round_id === manual.round_id).status).toBe("stale");
    expect(await calls()).toBe(1);
  });

  it("关闭服务可打断等待人工协调的升级，冷恢复补请求且不重放旧调用", async () => {
    await prepare(); await startManual(60_000); const run_id = await start();
    await waitFor(async () => (await server!.runs.getRun(run_id)).status === "failed");
    const started_at = Date.now(); await restart();
    expect(Date.now() - started_at).toBeLessThan(6000);
    await waitFor(async () => (await rounds()).some((round: any) => round.trigger === "goal_blocked" && round.status === "ok"));
    expect(await calls()).toBe(1); expect(await rounds()).toHaveLength(2);
  });
});
