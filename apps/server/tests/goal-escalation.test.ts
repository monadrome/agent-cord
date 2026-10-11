import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { GoalBlockerTriggerSchema, CoordinatorRoundRequestedPayloadSchema, GoalConfigSchema, readGoalCoordinationRequest, readGoalRetryAuthorization, type EventEnvelope } from "agent-cord";
import { createClient } from "../../console/src/api.js";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-supervisor.mjs", import.meta.url));
const manual_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
let root: string;
let server: BuiltServer | undefined;
let sequence = 0;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-goal-escalation-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });

async function api(method: "GET" | "POST", url: string, body?: unknown, key = "goal-escalation-" + sequence++) {
  const response = await server!.app.inject({ method, url: "/api/v1" + url,
    ...(method === "POST" ? { headers: { "idempotency-key": key } } : {}), ...(body === undefined ? {} : { payload: body }) });
  return { status: response.statusCode, body: response.json() };
}
async function waitFor(check: () => Promise<boolean>) { const deadline = Date.now() + 12_000; while (!await check()) { if (Date.now() > deadline) throw new Error("自动 Goal 升级等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function rounds() { return (await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).body.rounds; }
async function events() { return (await server!.sessions.open("REQ-GOAL-ESC")).events.readOrdered(); }
async function restart() { await server!.app.close(); server!.index.close(); server = await buildApp({ root }); }
async function calls() { return Number(await readFile(join(root, ".goal-supervisor-calls"), "utf8")); }
const retryUrl = (round_id: string) => "/requirements/REQ-GOAL-ESC/coordination/" + round_id + "/retry";
async function retryInput(round_id: string) { return { input_hash: (await server!.coordination.get("REQ-GOAL-ESC", round_id)).coordination_retry!.input_hash }; }
async function context() {
  const run = await server!.runs.latestRun("REQ-GOAL-ESC");
  const binding = await server!.sdlcs.get("goal-escalation", 1);
  const blocker = (await events()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
  return { req_id: "REQ-GOAL-ESC", run_id: run!.run_id, sdlc_id: run!.sdlc_id, sdlc_version: run!.sdlc_version,
    workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, node_id: "deliver", goal_event_id: blocker.event_id, supervisor_agent: "supervisor" };
}

async function prepare(options: { protocol?: "headless" | "acp"; mode?: string; sleep?: number; supervisor_agent?: string | null; checks_pass?: boolean; supervisor_timeout_ms?: number; supervisor_max_attempts?: number } = {}) {
  const protocol = options.protocol ?? "headless";
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [worker, "{{prompt}}"] },
    supervisor: { kind: protocol, bin: process.execPath, args: [supervisor, ...(protocol === "acp" ? ["--acp"] : []), "--mode", options.mode ?? "ask", "--sleep", String(options.sleep ?? 0), ...(protocol === "headless" ? ["{{prompt}}"] : [])] },
  } }));
  server = await buildApp({ root });
  const supervisor_agent = options.supervisor_agent === undefined ? "supervisor" : options.supervisor_agent;
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-escalation" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], max_attempts: 1, no_progress_limit: 1,
      ...(supervisor_agent === null ? {} : { supervisor_agent, supervisor_timeout_ms: options.supervisor_timeout_ms ?? 5_000, ...(options.supervisor_max_attempts === undefined ? {} : { supervisor_max_attempts: options.supervisor_max_attempts }) }),
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
  it.each(["headless", "acp"] as const)("%s supervisor输出失败自动重试成功，cold不重复/可答复授权且Goal预算独立", async protocol => {
    await prepare({ protocol, mode: "invalid-once", supervisor_max_attempts: 2 }); const run_id = await start();
    await waitFor(async () => (await rounds()).some((round: any) => round.status === "ok"));
    const list = await rounds(); expect(list.filter((round: any) => round.trigger === "goal_blocked")).toHaveLength(2);
    const failed = list[1]; const latest = list[0];
    expect(failed.status).toBe("failed"); expect(failed).not.toHaveProperty("retry_of_round_id");
    expect(latest).toMatchObject({ status: "ok", retry_of_round_id: failed.round_id, answerable: true });
    expect(await calls()).toBe(2); expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
    expect((await events()).filter(event => event.type === "coordinator.round.requested").every(event => event.actor.id === "goal-supervisor")).toBe(true);
    expect((await server!.runs.getRun(run_id)).status).toBe("failed");
    expect(server!.runs.workspaceLeaseStatus().state).toBe("free");
    const initial = (await events()).find(event => event.type === "coordinator.round.requested" && event.payload["retry_of_round_id"] === undefined)!;
    const child = (await events()).find(event => event.type === "coordinator.round.requested" && event.payload["retry_of_round_id"] !== undefined)!;
    expect(initial.payload["supervisor_max_attempts"]).toBe(2); expect(child.payload["automatic_retry"]).toEqual({ attempt: 2, max_attempts: 2 });
    expect(readGoalCoordinationRequest(await events(), latest.round_id)).toEqual(child);
    await restart(); expect(await calls()).toBe(2); expect((await rounds())[0]).toMatchObject({ status: "ok", answerable: true });
    expect((await api("POST", `/requirements/REQ-GOAL-ESC/coordination/${latest.round_id}/answer`, { choice: "补充事实" })).status).toBe(200);
    expect((await server!.coordination.get("REQ-GOAL-ESC", latest.round_id)).goal_retry?.available).toBe(true);
    expect((await events()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(1);
  });

  it.each([2, 3])("连续输出失败最多%d轮，保留最新人工retry token，冷恢复不扩次数", async limit => {
    await prepare({ mode: "invalid", supervisor_max_attempts: limit }); await start();
    await waitFor(async () => (await rounds()).length === limit && (await rounds())[0]?.status === "failed");
    expect(await calls()).toBe(limit); expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(1);
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
    const history = await events(); const requests = history.filter(event => event.type === "coordinator.round.requested");
    for (const request of requests) expect(readGoalCoordinationRequest(history, String(request.payload["round_id"]))).toEqual(request);
    expect(requests.at(-1)!.payload["automatic_retry"]).toEqual({ attempt: limit, max_attempts: limit });
    await restart(); expect(await calls()).toBe(limit); expect((await rounds())[0].coordination_retry.available).toBe(true);
    const parent = (await rounds())[0]; const input = await retryInput(parent.round_id);
    expect((await api("POST", retryUrl(parent.round_id), input)).status).toBe(202);
    await waitFor(async () => (await rounds()).length === limit + 1 && (await rounds())[0].status === "failed");
    expect(await calls()).toBe(limit + 1);
    expect((await events()).filter(event => event.type === "coordinator.round.requested").at(-1)!.actor.kind).toBe("human");
    expect((await events()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it.each(["headless", "acp"] as const)("%s timeout自动尝试到上限，输出与worker预算保持分离", async protocol => {
    await prepare({ protocol, sleep: 60000, supervisor_timeout_ms: 150, supervisor_max_attempts: 2 }); await start();
    await waitFor(async () => (await rounds()).length === 2 && (await rounds())[0].status === "timeout");
    expect((await rounds()).map((round: any) => round.status)).toEqual(["timeout", "timeout"]);
    expect((await events()).filter(event => event.type === "coordinator.round.started")).toHaveLength(2);
    await restart(); expect(await rounds()).toHaveLength(2);
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
  });

  it.each(["wait", "ask", "tool", "missing-config", "cancelled", "stale"])("%s不会自动产生子请求", async mode => {
    await prepare({ mode: mode === "stale" || mode === "cancelled" ? "invalid" : mode, sleep: mode === "stale" || mode === "cancelled" ? 300 : 0,
      supervisor_agent: mode === "missing-config" ? "missing-supervisor" : "supervisor", supervisor_max_attempts: 3 });
    await start();
    if (mode === "cancelled" || mode === "stale") {
      await waitFor(async () => (await rounds())[0]?.status === "running");
      if (mode === "cancelled") await api("POST", `/requirements/REQ-GOAL-ESC/coordination/${(await rounds())[0].round_id}/cancel`);
      else await writeFile(join(root, "value.txt"), "changed-during-supervisor");
    }
    await waitFor(async () => (await rounds()).length === 1 && !["pending", "running"].includes((await rounds())[0].status));
    await server!.coordination.close(); expect(await rounds()).toHaveLength(1);
    expect((await events()).filter(event => event.type === "coordinator.round.requested")).toHaveLength(1);
    expect((await events()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it.each(["prd", "worker", "supervisor", "archive", "cancel-fact"])("首轮完成后%s变化阻断自动retry而不采用新输入", async mode => {
    await prepare({ mode: "invalid-once", supervisor_max_attempts: 2 });
    const session = await server!.sessions.open("REQ-GOAL-ESC"); const append = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await append(draft);
      if (draft.type === "coordinator.round.completed") {
        if (mode === "prd") await writeFile(join(session.dir, "prd.md"), "# PRD\nCHANGED_AFTER_COMPLETION");
        else if (mode === "archive") await server!.sdlcs.archive("goal-escalation", 1);
        else if (mode === "cancel-fact") {
          const start = (await events()).find(event => event.type === "workflow.run.started")!;
          await append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.cancelled", schema_version: "1", actor: { kind: "human", id: "local-human" },
            correlation_id: null, source: { adapter: "console-server" }, payload: { workflow_id: "goal-escalation", workflow_revision: start.payload["workflow_revision"], run_id: start.payload["run_id"] } });
          server!.index.setRunStatus(String(start.payload["run_id"]), "cancelled");
        }
        else { const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8")); config.agents[mode].context_revision = 2; await writeFile(file, stringify(config)); await server!.agents.reload(); }
      }
      return event;
    });
    await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    await server!.coordination.close(); mock.mockRestore(); expect(await rounds()).toHaveLength(1); expect(await calls()).toBe(1);
  });

  it("发布次数须1-3且有supervisor；request自动字段不完整或超上限拒绝", () => {
    const base = { inputs: ["value.txt"], checks: [{ id: "check", bin: "test" }] };
    for (const value of [0, 4, 1.5, "2"]) expect(GoalConfigSchema.safeParse({ ...base, supervisor_agent: "supervisor", supervisor_max_attempts: value }).success).toBe(false);
    expect(GoalConfigSchema.safeParse({ ...base, supervisor_max_attempts: 2 }).success).toBe(false);
    expect(GoalConfigSchema.parse(base)).not.toHaveProperty("supervisor_max_attempts");
    const request = { round_id: ulid(), workflow_id: "test", driver: "supervisor", sdlc_id: "test", sdlc_version: 1 };
    expect(CoordinatorRoundRequestedPayloadSchema.safeParse({ ...request, automatic_retry: { attempt: 2, max_attempts: 2 } }).success).toBe(false);
    expect(CoordinatorRoundRequestedPayloadSchema.safeParse({ ...request, supervisor_max_attempts: 2 }).success).toBe(false);
  });

  it.each(["input", "configuration", "interrupt", "write-failure", "pre-dispatch-input"])("自动子请求%s时不重复/不冒成功，冷历史与显式重试可恢复", async mode => {
    await prepare({ mode: "invalid-once", supervisor_max_attempts: 2 });
    const session = await server!.sessions.open("REQ-GOAL-ESC"); const append = session.events.append.bind(session.events); let child_id: string | null = null;
    const mock = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const automatic = draft.type === "coordinator.round.requested" && draft.payload["automatic_retry"] !== undefined;
      if (mode === "write-failure" && automatic) throw new Error("automatic request fsync failure");
      const event = await append(draft);
      if (automatic) {
        child_id = String(event.payload["round_id"]);
        if (mode === "input") await writeFile(join(session.dir, "prd.md"), "# PRD\nCHANGED_AFTER_AUTO_REQUEST");
        else if (mode === "configuration") { const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8")); config.agents.supervisor.context_revision = 2; await writeFile(file, stringify(config)); await server!.agents.reload(); }
        else if (mode === "interrupt") throw new Error("automatic request recorded before interruption");
      }
      if (mode === "pre-dispatch-input" && draft.type === "coordinator.round.started" && draft.payload["round_id"] === child_id) {
        await writeFile(join(session.dir, "prd.md"), "# PRD\nCHANGED_AFTER_AUTO_STARTED");
      }
      return event;
    });
    await start();
    await waitFor(async () => mode === "write-failure" ? (await rounds())[0]?.status === "failed"
      : child_id !== null && (mode === "interrupt" || !["pending", "running"].includes((await rounds())[0].status)));
    await server!.coordination.close(); mock.mockRestore();
    const list = await rounds();
    if (mode === "configuration") { expect(list).toHaveLength(2); expect(list[0].status).toBe("ok"); expect(await calls()).toBe(2); }
    else { expect(await calls()).toBe(1); expect(list).toHaveLength(mode === "write-failure" ? 1 : 2); }
    if (mode === "input") expect(list[0]).toMatchObject({ status: "failed", failure_stage: "interrupted" });
    if (mode === "interrupt") expect(list[0]).toMatchObject({ status: "pending" });
    if (mode === "pre-dispatch-input") expect(list[0]).toMatchObject({ status: "stale", proposal: null });
    for (const round of list) readGoalCoordinationRequest(await events(), round.round_id);
    await restart(); expect(await calls()).toBe(mode === "configuration" ? 2 : 1);
    if (mode === "interrupt") expect((await rounds())[0]).toMatchObject({ status: "failed", failure_stage: "interrupted" });
    if (mode !== "configuration") {
      const latest = (await rounds())[0]; const input = await retryInput(latest.round_id);
      expect((await api("POST", retryUrl(latest.round_id), input)).status).toBe(202);
      await waitFor(async () => (await rounds())[0].status === "ok"); expect(await calls()).toBe(2);
    }
    expect((await events()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("服务关闭能收束自动子调用，重启不重放也不接着扩次数", async () => {
    await prepare({ mode: "invalid-once", sleep: 300, supervisor_max_attempts: 3 }); await start();
    await waitFor(async () => (await rounds()).length === 2 && (await rounds())[0]?.status === "running" && await calls() === 2);
    await restart(); expect(await calls()).toBe(2); expect(await rounds()).toHaveLength(2);
    expect((await rounds())[0].status).toBe("cancelled");
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
  });

  it("published上限不能由升级回调数字扩充，缺首次request冷恢复仍使用发布上限", async () => {
    await prepare({ mode: "invalid-once", supervisor_max_attempts: 2 }); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC"));
    await server!.coordination.escalateGoalBlocker({ ...await context(), supervisor_max_attempts: 3 });
    expect(await calls()).toBe(2); expect((await events()).filter(event => event.type === "coordinator.round.requested")[0]!.payload["supervisor_max_attempts"]).toBe(2);
    expect((await server!.runs.getRun(run_id)).status).toBe("failed");
  });

  it("未写首次request的blocker重启自动解释两次，后续cold不重复", async () => {
    await prepare({ mode: "invalid-once", supervisor_max_attempts: 2 }); server!.runs.setGoalBlockedHandler(async () => {}); await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC")); expect(await rounds()).toHaveLength(0);
    await restart(); await waitFor(async () => (await rounds())[0]?.status === "ok"); expect(await calls()).toBe(2);
    await restart(); expect(await calls()).toBe(2); expect(await rounds()).toHaveLength(2);
  });

  it.each(["actor", "missing-automatic", "attempt", "budget", "root-budget", "parent-stage", "parent-config", "child-input", "duplicate-child"])("自动来源%s伪造拒绝，恢复真实历史仍可答复", async mode => {
    await prepare({ mode: "invalid-once", supervisor_max_attempts: 2 }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "ok"); const list = await rounds(); const child = list[0]; const parent = list[1];
    const actual = await events(); const broken = structuredClone(actual); const request = broken.find(event => event.type === "coordinator.round.requested" && event.payload["round_id"] === child.round_id)!;
    const initial = broken.find(event => event.type === "coordinator.round.requested" && event.payload["round_id"] === parent.round_id)!;
    const completed = broken.find(event => event.type === "coordinator.round.completed" && event.payload["round_id"] === parent.round_id)!;
    if (mode === "actor") request.actor.kind = "human";
    if (mode === "missing-automatic") delete request.payload["automatic_retry"];
    if (mode === "attempt") request.payload["automatic_retry"] = { attempt: 3, max_attempts: 3 };
    if (mode === "budget") request.payload["automatic_retry"] = { attempt: 2, max_attempts: 3 };
    if (mode === "root-budget") delete initial.payload["supervisor_max_attempts"];
    if (mode === "parent-stage") completed.payload["failure_stage"] = "configuration";
    if (mode === "parent-config") completed.payload["agent_configuration_hash"] = "a".repeat(64);
    if (mode === "child-input") broken.find(event => event.type === "coordinator.round.completed" && event.payload["round_id"] === child.round_id)!.payload["input_hash"] = "a".repeat(64);
    if (mode === "duplicate-child") broken.push({ ...request, event_id: ulid(), payload: { ...request.payload, round_id: ulid() } });
    expect(() => readGoalCoordinationRequest(broken, child.round_id)).toThrow();
    expect(readGoalCoordinationRequest(actual, child.round_id).payload["automatic_retry"]).toEqual({ attempt: 2, max_attempts: 2 });
  });
  it("ready 后源码改变且预算耗尽时仍可识别 blocked 并自动升级，不新增 worker 尝试", async () => {
    await prepare({ checks_pass: true }); await start();
    await waitFor(async () => (await api("GET", "/requirements/REQ-GOAL-ESC/approvals")).body.approvals.length === 1);
    const original = (await api("GET", "/requirements/REQ-GOAL-ESC/approvals")).body.approvals[0];
    await writeFile(join(root, "value.txt"), "new-input");
    expect((await api("POST", "/requirements/REQ-GOAL-ESC/approvals/" + original.approval_id + "/decide", { choice: original.options[0] })).status).toBe(409);
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    expect((await rounds())[0]).toMatchObject({ trigger: "goal_blocked", answerable: true });
    expect((await events()).filter(event => event.type === "goal.attempt.completed").at(-1)?.payload).toMatchObject({ attempt: 1, max_attempts: 1, status: "blocked", failure_kind: "budget" });
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(1);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
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

  it.each(["headless", "acp"] as const)("%s 失败轮次重试到可答复问题，父请求可持久重放且不增加 worker/Goal 预算", async protocol => {
    await prepare({ protocol, mode: "invalid-once" }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "failed");
    const failed = (await rounds())[0]; const worker_calls = Number(await readFile(join(root, ".goal-worker-calls"), "utf8"));
    const input = await retryInput(failed.round_id);
    const response = await api("POST", retryUrl(failed.round_id), input);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    await waitFor(async () => (await rounds()).some((round: any) => round.round_id !== failed.round_id && ["failed", "ok"].includes(round.status)));
    const next = (await rounds()).find((round: any) => round.round_id !== failed.round_id)!;
    expect(next).toMatchObject({ trigger: "goal_blocked", goal_event_id: failed.goal_event_id, run_id: failed.run_id, node_id: failed.node_id, retry_of_round_id: failed.round_id });
    expect(await calls()).toBe(2); expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(worker_calls);
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
    expect(next.status).toBe("ok"); expect(next.answerable).toBe(true);
    expect((await api("POST", retryUrl(failed.round_id), input)).body.round.round_id).toBe(next.round_id);
    expect((await api("POST", retryUrl(failed.round_id), { input_hash: "a".repeat(64) })).status).toBe(409);
    await restart(); expect(await calls()).toBe(2);
    expect((await api("POST", retryUrl(failed.round_id), input)).body.round.round_id).toBe(next.round_id);
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "goal.retry.authorized")).toHaveLength(0);
  });

  it("stale 自动轮次读取最新 token 重试同 blocker，修复配置须明确新 token", async () => {
    await prepare({ sleep: 800 }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "running");
    const first = (await rounds())[0]; await writeFile(join(root, "value.txt"), "changed-input");
    await waitFor(async () => (await rounds())[0]?.status === "stale");
    const input = await retryInput(first.round_id);
    const retry = await api("POST", retryUrl(first.round_id), input);
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    await waitFor(async () => (await rounds()).some((round: any) => round.round_id !== first.round_id && ["failed", "ok"].includes(round.status)));
    expect(await calls()).toBe(2);
    expect((await api("POST", retryUrl(first.round_id), input)).body.round.round_id).toBe(retry.body.round.round_id);
    const latest = (await rounds()).find((round: any) => round.round_id !== first.round_id)!;
    expect(latest.status).toBe("ok"); expect(latest.coordination_retry.available).toBe(false);
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
      worker: { kind: "headless", bin: process.execPath, args: [worker, "{{prompt}}"] },
      supervisor: { kind: "headless", bin: process.execPath, args: [supervisor, "--mode", "invalid", "{{prompt}}"] },
    } }));
    await server!.agents.reload();
    const refreshed = (await server!.coordination.get("REQ-GOAL-ESC", latest.round_id)).coordination_retry!;
    expect(refreshed.available).toBe(true);
    expect((await api("POST", retryUrl(latest.round_id), { input_hash: "a".repeat(64) })).status).toBe(409);
    expect((await api("POST", retryUrl(latest.round_id), { input_hash: refreshed.input_hash })).status).toBe(202);
  });

  it("不同幂等键并发同依据只记录一个子请求，未知 token/参数/幂等键拒绝", async () => {
    await prepare({ mode: "invalid-once" }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id);
    expect((await api("POST", retryUrl(first.round_id), { ...input, agent: "worker" })).status).toBe(400);
    expect((await api("POST", retryUrl(first.round_id), { input_hash: "a".repeat(64) })).status).toBe(409);
    const no_key = await server!.app.inject({ method: "POST", url: "/api/v1" + retryUrl(first.round_id), payload: input }); expect(no_key.statusCode).toBe(400);
    const responses = await Promise.all([api("POST", retryUrl(first.round_id), input, "retry-a"), api("POST", retryUrl(first.round_id), input, "retry-b")]);
    expect(responses.map(item => item.status)).toEqual([202, 202]); expect(responses[0]!.body.round.round_id).toBe(responses[1]!.body.round.round_id);
    expect((await api("POST", retryUrl(first.round_id), input, "retry-a")).body).toEqual(responses[0]!.body);
    await waitFor(async () => (await rounds())[0]?.status === "ok"); expect(await calls()).toBe(2);
    expect((await events()).filter(event => event.type === "coordinator.round.requested" && event.payload["retry_of_round_id"] === first.round_id)).toHaveLength(1);
  });

  it("最新需求变化使旧 token 409，读取当前 token 可继续同 blocker", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const session = await server!.sessions.open("REQ-GOAL-ESC");
    await writeFile(join(session.dir, "prd.md"), "# Goal\n最新必要事实，新协调需要读取此标记 LATEST_RETRY_PRD\n");
    expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(409); expect(await calls()).toBe(1);
    const current = await retryInput(first.round_id); expect(current.input_hash).not.toBe(input.input_hash);
    expect((await api("POST", retryUrl(first.round_id), current)).status).toBe(202);
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    expect(await readFile(join(root, ".goal-supervisor-prompts.jsonl"), "utf8")).toContain("LATEST_RETRY_PRD");
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(1);
  });

  it("请求写失败不派发；修复后可重试，父 round/config 部分字段或坏来源拒绝", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const session = await server!.sessions.open("REQ-GOAL-ESC");
    const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => { if (draft.type === "coordinator.round.requested") throw Error("retry request fsync failure"); return original(draft); });
    try { expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(500); }
    finally { append.mockRestore(); }
    expect(await calls()).toBe(1); expect(await rounds()).toHaveLength(1);
    const response = await api("POST", retryUrl(first.round_id), input); expect(response.status).toBe(202);
    await waitFor(async () => (await rounds())[0]?.status === "ok"); const facts = await events();
    const request = readGoalCoordinationRequest(facts, response.body.round.round_id);
    for (const change of [
      { actor: { kind: "system", id: "goal-supervisor" } }, { source: { adapter: "foreign" } }, { session_id: "REQ-OTHER" },
      { payload: { ...request.payload, retry_of_round_id: "01ARZ3NDEKTSV4RRFFQ69G5F00" } },
      { payload: { ...request.payload, driver: "foreign" } }, { payload: { ...request.payload, retry_configuration_hash: "a".repeat(64) } },
    ]) expect(() => readGoalCoordinationRequest(facts.map(event => event.event_id === request.event_id ? { ...event, ...change } as EventEnvelope : event), response.body.round.round_id)).toThrow();
    const { retry_of_round_id, retry_input_hash, retry_configuration_hash, ...base } = request.payload;
    expect(CoordinatorRoundRequestedPayloadSchema.safeParse({ ...base, retry_of_round_id }).success).toBe(false);
    expect(CoordinatorRoundRequestedPayloadSchema.safeParse({ ...base, retry_input_hash, retry_configuration_hash }).success).toBe(false);
  });

  it.each(["input", "configuration"])("记录前 %s 变化拒绝旧请求，不派发新 supervisor", async change => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const original = server!.sdlcs.get.bind(server!.sdlcs); let switched = false;
    const get = vi.spyOn(server!.sdlcs, "get").mockImplementation(async (...args) => {
      const value = await original(...args);
      if (!switched) { switched = true;
        if (change === "input") await writeFile(join(root, "value.txt"), "LATE_RETRY_CHANGE");
        else { const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8")); config.agents.supervisor.context_revision = 2; await writeFile(file, stringify(config)); await server!.agents.reload(); }
      } return value;
    });
    try { expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(409); }
    finally { get.mockRestore(); }
    expect(await calls()).toBe(1); expect(await rounds()).toHaveLength(1);
  });

  it("请求落盘后配置重载保持固定 resolver，输入变化则记录未派发终态", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const session = await server!.sessions.open("REQ-GOAL-ESC");
    const original = session.events.append.bind(session.events); const config_hash = server!.agents.resolver()("supervisor").configuration_hash;
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await original(draft);
      if (draft.type === "coordinator.round.requested") { const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8")); config.agents.supervisor.context_revision = 2; await writeFile(file, stringify(config)); await server!.agents.reload(); }
      return result;
    });
    let response;
    try { response = await api("POST", retryUrl(first.round_id), input); expect(response.status, JSON.stringify(response.body)).toBe(202); }
    finally { append.mockRestore(); }
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    const next = (await rounds())[0]; expect(next.agent_configuration_hash).toBe(config_hash); expect(next.current).toBe(false);
    const next_input = await retryInput(next.round_id);
    const changed = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await original(draft); if (draft.type === "coordinator.round.requested") await writeFile(join(root, "value.txt"), "AFTER_REQUEST_CHANGED"); return result;
    });
    try { expect((await api("POST", retryUrl(next.round_id), next_input)).status).toBe(409); }
    finally { changed.mockRestore(); }
    expect(await calls()).toBe(2); expect((await rounds())[0]).toMatchObject({ status: "failed", failure_stage: "interrupted", retry_of_round_id: next.round_id });
  });

  it("typed HTTP 重试问题可答复后授权 Goal，冷恢复验证重试来源链", async () => {
    await prepare({ mode: "invalid-once", checks_pass: false }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const file = join(root, "cord", "agents.yaml"); const config = parse(await readFile(file, "utf8")); config.agents.supervisor.args = [supervisor, "--mode", "ask", "{{prompt}}"];
    await writeFile(file, stringify(config)); await server!.agents.reload();
    const first = (await rounds())[0]; await server!.app.listen({ port: 0, host: "127.0.0.1" }); const address = server!.app.server.address();
    if (address === null || typeof address === "string") throw Error("没有 HTTP 端口"); const client = createClient("http://127.0.0.1:" + address.port);
    const input = await retryInput(first.round_id); const response = await client.retryCoordination("REQ-GOAL-ESC", first.round_id, input.input_hash!, "typed-retry");
    expect(await client.retryCoordination("REQ-GOAL-ESC", first.round_id, input.input_hash!, "typed-retry")).toEqual(response);
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    const recorded = await client.answerCoordination("REQ-GOAL-ESC", response.round.round_id, { choice: "补充事实" });
    const authorized = await client.retryGoal("REQ-GOAL-ESC", response.round.round_id, { answer_event_id: recorded.round.answer!.event_id, input_hash: recorded.round.goal_retry!.input_hash! });
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC"));
    expect(readGoalRetryAuthorization(await events(), authorized.run.run_id)).not.toBeNull();
    const worker_calls = Number(await readFile(join(root, ".goal-worker-calls"), "utf8")); const supervisor_calls = await calls(); await restart();
    expect(readGoalRetryAuthorization(await events(), authorized.run.run_id)).not.toBeNull();
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(worker_calls); expect(await calls()).toBe(supervisor_calls);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("请求落盘后中断不重放 supervisor，冷恢复标记 interrupted 后可重试子 round", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const session = await server!.sessions.open("REQ-GOAL-ESC");
    const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await original(draft); if (draft.type === "coordinator.round.requested") throw Error("persisted request then interrupted"); return event;
    });
    try { expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(500); }
    finally { append.mockRestore(); }
    expect(await calls()).toBe(1); await restart(); expect(await calls()).toBe(1);
    const child = (await rounds())[0]; expect(child).toMatchObject({ status: "failed", failure_stage: "interrupted", retry_of_round_id: first.round_id });
    expect((await api("POST", retryUrl(first.round_id), input)).body.round.round_id).toBe(child.round_id);
    expect((await api("POST", retryUrl(child.round_id), await retryInput(child.round_id))).status).toBe(202);
    await waitFor(async () => (await rounds())[0]?.status === "ok"); expect(await calls()).toBe(2);
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(1);
    await restart(); expect(await calls()).toBe(2); expect(await rounds()).toHaveLength(3);
  });
  it("request 重检之后的快照捕获漂移记 stale，预期输入不匹配时不调用模型", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const original = server!.coordination.get.bind(server!.coordination);
    const get = vi.spyOn(server!.coordination, "get").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result.status === "pending" && result.retry_of_round_id === first.round_id) await writeFile(join(root, "value.txt"), "CAPTURE_CHANGED");
      return result;
    });
    try { expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(202); }
    finally { get.mockRestore(); }
    await waitFor(async () => (await rounds())[0]?.status === "stale");
    expect(await calls()).toBe(1); expect((await rounds())[0]).toMatchObject({ failure_stage: "freshness", retry_of_round_id: first.round_id });
  });

  it.each(["timeout", "cancelled"])("%s 终态重试沿用发布超时，不能更改 Goal/权限预算", async status => {
    await prepare({ sleep: 800, supervisor_timeout_ms: status === "timeout" ? 100 : 5000 }); await start();
    if (status === "cancelled") {
      await waitFor(async () => (await rounds())[0]?.status === "running");
      await api("POST", "/requirements/REQ-GOAL-ESC/coordination/" + (await rounds())[0].round_id + "/cancel");
    }
    await waitFor(async () => (await rounds())[0]?.status === status);
    const first = (await rounds())[0]; const input = await retryInput(first.round_id);
    const response = await api("POST", retryUrl(first.round_id), input); expect(response.status, JSON.stringify(response.body)).toBe(202);
    await waitFor(async () => ["ok", "timeout"].includes((await rounds())[0]?.status));
    expect((await rounds())[0].status).toBe(status === "timeout" ? "timeout" : "ok");
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(1);
    expect((await events()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("已归档/答复/被新 run 替代的 blocker 不提供重试，坏重试来源冷恢复隔离", async () => {
    await prepare({ mode: "invalid-once" }); await start(); await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id);
    await server!.sdlcs.archive("goal-escalation", 1);
    expect((await api("POST", retryUrl(first.round_id), input)).status).toBe(409); expect((await rounds())[0].coordination_retry.available).toBe(false);
    await server!.sdlcs.unarchive("goal-escalation", 1);
    const response = await api("POST", retryUrl(first.round_id), input); expect(response.status).toBe(202);
    await waitFor(async () => (await rounds())[0]?.status === "ok");
    const child = (await rounds())[0]; await api("POST", "/requirements/REQ-GOAL-ESC/coordination/" + child.round_id + "/answer", { choice: "补充事实" });
    expect((await rounds())[0].coordination_retry.available).toBe(false);
    const session = await server!.sessions.open("REQ-GOAL-ESC"); const facts = await events(); await server!.app.close(); server!.index.close(); server = undefined;
    await writeFile(join(session.dir, "events.jsonl"), facts.map(event => JSON.stringify(event.type === "coordinator.round.requested" && event.payload["retry_of_round_id"] !== undefined ? { ...event, actor: { kind: "system", id: "goal-supervisor" } } : event)).join("\n") + "\n");
    server = await buildApp({ root }); expect(await calls()).toBe(2); expect((await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).status).toBe(500);
  });

  it("父命令在子 round 活动期间重放同轮次，活动子 round 不能再请求重试", async () => {
    await prepare({ mode: "invalid", sleep: 500 }); await start();
    await waitFor(async () => (await rounds())[0]?.status === "failed");
    const first = (await rounds())[0]; const input = await retryInput(first.round_id); const retry = await api("POST", retryUrl(first.round_id), input);
    expect(retry.status).toBe(202);
    expect((await api("POST", retryUrl(first.round_id), input)).body.round.round_id).toBe(retry.body.round.round_id);
    expect((await api("POST", retryUrl(retry.body.round.round_id), { input_hash: "a".repeat(64) })).status).toBe(409);
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

  it("错误system actor的blocked事实在request写入前拒绝，不污染协调列表；合法来源修复后可升级", async () => {
    await prepare(); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    const session = await server!.sessions.open("REQ-GOAL-ESC"); const original = (await events()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
    const append_blocker = (id: string) => session.events.append({ event_id: ulid(), session_id: session.req_id, type: "goal.attempt.completed", schema_version: "1",
      actor: { kind: "system", id }, correlation_id: "deliver", source: { adapter: "goal-runner" }, payload: original.payload });
    const invalid = await append_blocker("foreign-system");
    await expect(server!.coordination.start(session.req_id, { agent: "supervisor", sdlc_id: "goal-escalation", sdlc_version: 1 },
      { run_id, node_id: "deliver", goal_event_id: invalid.event_id })).rejects.toThrow(/来源/);
    expect((await events()).filter(event => event.type === "coordinator.round.requested")).toHaveLength(0);
    expect((await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).status).toBe(200);
    await expect(calls()).rejects.toThrow();
    const restored = await append_blocker("goal-runner");
    const created = await server!.coordination.start(session.req_id, { agent: "supervisor", sdlc_id: "goal-escalation", sdlc_version: 1 },
      { run_id, node_id: "deliver", goal_event_id: restored.event_id });
    await waitFor(async () => (await rounds())[0]?.status === "ok"); expect(created.goal_event_id).toBe(restored.event_id); expect(await calls()).toBe(1);
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "goal.retry.authorized")).toHaveLength(0);
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

  it("目标blocker ID重复时写前拒绝，不选择第一条来源", async () => {
    await prepare(); server!.runs.setGoalBlockedHandler(async () => {}); const run_id = await start();
    await waitFor(async () => !server!.runs.isActive("REQ-GOAL-ESC") && (await server!.runs.getRun(run_id)).status === "failed");
    const ctx = await context(); const session = await server!.sessions.open("REQ-GOAL-ESC"); const read = session.events.readOrderedStrict!.bind(session.events);
    const mock = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => {
      const original = await read(); const source = original.find(event => event.event_id === ctx.goal_event_id)!;
      return [...original, { ...source, seq: original.at(-1)!.seq + 1 }];
    });
    try {
      await expect(server!.coordination.start(session.req_id, { agent: "supervisor", sdlc_id: "goal-escalation", sdlc_version: 1 },
        { run_id, node_id: "deliver", goal_event_id: ctx.goal_event_id })).rejects.toThrow(/来源/);
    } finally { mock.mockRestore(); }
    expect((await events()).filter(event => event.type === "coordinator.round.requested")).toHaveLength(0); await expect(calls()).rejects.toThrow();
    expect((await api("GET", "/requirements/REQ-GOAL-ESC/coordination")).status).toBe(200);
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
