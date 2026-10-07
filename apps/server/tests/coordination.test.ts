/** 独立协调 API：真实 Fastify + 离线 headless 子进程，验证幂等、固定配置、取消和恢复。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { CoordinationRoundView } from "@agent-cord/server/contracts";
import { EVENT_PAYLOAD_SCHEMAS, type EventType } from "agent-cord";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
const acp_fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-acp-agent.mjs");
const proposal = { summary: "当前需求可推进", next_action: { kind: "advance", node_id: "intake", reason: "先确认需求", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
let root: string;
let server: BuiltServer;

async function config(output = JSON.stringify(proposal), sleep_ms = 0): Promise<void> {
  await mkdir(join(root, "cord"), { recursive: true });
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
    kind: "headless", bin: process.execPath,
    args: [fixture, "--mode", "claude", "--sleep", String(sleep_ms), "--result-text", output, "{{prompt}}"],
  } } }));
}
async function request(method: "GET" | "POST" | "PUT", url: string, payload?: unknown, key?: string) {
  const response = await server.app.inject({ method, url,
    headers: { ...(key !== undefined ? { "idempotency-key": key } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}
async function wait_for(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待协调测试状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function start(key = "coordinate", extra: Record<string, unknown> = {}) {
  return request("POST", "/api/v1/requirements/REQ-CONTEXT/coordination", { agent: "coordinator", ...extra }, key);
}
async function done(round_id: string): Promise<CoordinationRoundView> {
  let round: CoordinationRoundView | undefined;
  await wait_for(async () => {
    const response = await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round_id}`);
    expect(response.status).toBe(200);
    round = response.body.round;
    return round !== undefined && round.status !== "pending" && round.status !== "running";
  });
  return round!;
}
async function restart(): Promise<void> {
  await server.app.close();
  server.index.close();
  server = await buildApp({ root });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-coordination-api-"));
  await config();
  server = await buildApp({ root });
  expect((await request("POST", "/api/v1/requirements", { req_id: "REQ-CONTEXT", title: "协调原型", prd: "# PRD\nCURRENT_CONTEXT" }, "create")).status).toBe(201);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

async function valid_round(): Promise<CoordinationRoundView> {
  const result = await start(ulid());
  expect(result.status).toBe(202);
  const round = await done(result.body.round.round_id);
  expect(round.status).toBe("ok");
  return round;
}
function adopt(round_id: string, key = ulid()) {
  return request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${round_id}/adopt`, {}, key);
}

describe("协调提议受控采用", () => {
  it("采用当前 advance 提议启动绑定 SDLC，事实在节点派发前落盘，人工 gate 仍挂起", async () => {
    const round = await valid_round();
    expect(round).toMatchObject({ agent: "coordinator", current: true, adoptable: true, adopted_run_id: null });
    expect((await request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}/adopt`, {})).status).toBe(400);
    const response = await adopt(round.round_id);
    expect(response.status).toBe(202);
    const run_id = response.body.run.run_id;
    expect(server.index.getRun(run_id)?.coordination_round_id).toBe(round.round_id);
    expect(response.body.run).toMatchObject({ sdlc_id: "simple-sdlc", sdlc_version: 1 });
    await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
    const after = await server.coordination.get("REQ-CONTEXT", round.round_id);
    expect(after).toMatchObject({ status: "ok", adoptable: false, adopted_run_id: run_id });
    const events = await server.sessions.readEvents("REQ-CONTEXT");
    const adoption = events.find((event) => event.type === "coordinator.round.adopted")!;
    expect(adoption.actor.kind).toBe("human");
    expect(adoption.payload).toMatchObject({ round_id: round.round_id, workflow_id: round.workflow_id, node_id: "intake", input_hash: round.input_hash, run_id });
    expect(EVENT_PAYLOAD_SCHEMAS["coordinator.round.adopted"]?.safeParse(adoption.payload).success).toBe(true);
    expect(adoption.seq).toBeLessThan(events.find((event) => event.type === "workflow.node.entered")!.seq);
    expect(events.filter((event) => event.type === "gate.resolved").some((event) => (event.payload as Record<string, unknown>).human_confirmed === true)).toBe(false);
  });

  it("历史 ok 在文档变化后 current=false，采用 409 且不登记 run；恢复原输入可以重新核验", async () => {
    const round = await valid_round();
    const file = join(root, "cord", "REQ-CONTEXT", "prd.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, "# PRD\nCHANGED_AFTER_COMPLETION");
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "ok", current: false, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    await writeFile(file, original);
    expect((await server.coordination.get("REQ-CONTEXT", round.round_id)).adoptable).toBe(true);
  });

  it("同别名配置变化后旧提议不可采用，使用 requested 的原别名核验配置", async () => {
    const round = await valid_round();
    expect(round.agent).toBe("coordinator");
    expect(round.driver).toBe("headless:coordinator");
    await config(JSON.stringify({ ...proposal, summary: "CHANGED_CONFIGURATION" }));
    await server.agents.reload();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "ok", current: false, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    const fresh = await valid_round();
    expect((await adopt(fresh.round_id)).status).toBe(202);
  });

  it("同轮并发采用只启动一个 run，取消和重启后重复采用仍返回原 run", async () => {
    const round = await valid_round();
    const results = await Promise.all([adopt(round.round_id), adopt(round.round_id), adopt(round.round_id)]);
    expect(results.map((item) => item.status)).toEqual([202, 202, 202]);
    expect(new Set(results.map((item) => item.body.run.run_id)).size).toBe(1);
    const run_id = results[0]!.body.run.run_id;
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
    await server.runs.cancel(run_id);
    await writeFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "# AFTER_ADOPTION_CHANGE");
    await restart();
    const replay = await adopt(round.round_id);
    expect(replay.status).toBe(202);
    expect(replay.body.run).toMatchObject({ run_id, status: "cancelled" });
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.adopted")).toHaveLength(1);
  });

  it("普通 run 与采用并发只允许一个进入运行槽位", async () => {
    const round = await valid_round();
    const results = await Promise.all([adopt(round.round_id), request("POST", "/api/v1/requirements/REQ-CONTEXT/runs", {}, "ordinary-run")]);
    expect(results.map((item) => item.status).sort()).toEqual([202, 409]);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
  });

  it("进入 run 槽位后再次核验：查询有效但文件在启动前变化仍 409", async () => {
    const round = await valid_round();
    const real_start = server.runs.start.bind(server.runs);
    vi.spyOn(server.runs, "start").mockImplementation(async (...args) => {
      await writeFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "# CHANGED_BEFORE_RESERVED_VALIDATION");
      return real_start(...args);
    });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "coordinator.round.adopted")).toBe(false);
  });

  it("采用事件追加失败不派发节点，登记 failed 并释放槽位，修复后可再次采用", async () => {
    const round = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    const real_append = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "coordinator.round.adopted" ? Promise.reject(new Error("adoption store unavailable")) : real_append(draft));
    expect((await adopt(round.round_id)).status).toBe(500);
    expect(server.runs.listRuns("REQ-CONTEXT")[0]?.status).toBe("failed");
    expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "workflow.node.entered" || event.type === "coordinator.round.adopted")).toBe(false);
    mock.mockRestore();
    expect((await adopt(round.round_id)).status).toBe(202);
  });

  it("归档版本阻止采用，历史输入身份仍有效", async () => {
    const round = await valid_round();
    await server.sdlcs.archive("simple-sdlc", 1);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: true, adoptable: false, adoption_reason: "绑定的 SDLC 版本已归档" });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
  });

  it.each(["wait", "ask_human"])("%s 是有效 Draft，但不能制造节点推进或人工 gate 决策", async (kind) => {
    await config(JSON.stringify({ ...proposal, next_action: { kind, reason: "需要人工补充事实", evidence: proposal.next_action.evidence,
      ...(kind === "ask_human" ? { question: "是否采用该范围？", options: ["采用", "调整"] } : {}) } }));
    await server.agents.reload();
    const round = await valid_round();
    expect(round).toMatchObject({ current: true, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "gate.resolved" || event.type === "workflow.node.exited")).toBe(false);
  });

  it("没有配置身份的旧成功事件不能被采用", async () => {
    const session = await server.sessions.open("REQ-CONTEXT");
    const round_id = ulid();
    for (const [type, payload] of [
      ["coordinator.round.requested", { round_id, workflow_id: "simple-sdlc", driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }],
      ["coordinator.round.completed", { round_id, workflow_id: "simple-sdlc", driver: "coordinator", status: "ok", proposal, error: null, duration_ms: 1, input_hash: "a".repeat(64) }],
    ] as const) await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "system", id: "legacy" }, correlation_id: round_id, payload, source: { adapter: "test" } });
    expect(await server.coordination.get("REQ-CONTEXT", round_id)).toMatchObject({ current: null, adoptable: false });
    expect((await adopt(round_id)).status).toBe(409);
  });

  it("采用事实必须匹配提议的 workflow/节点/输入，不能因错误引用伪装成已采用", async () => {
    const round = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.adopted", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round.round_id,
      payload: { round_id: round.round_id, workflow_id: "OTHER_WORKFLOW", node_id: "intake", input_hash: round.input_hash, run_id: ulid() }, source: { adapter: "test" } });
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}`)).status).toBe(500);
  });

  it.each([false, true])("登记与派发间中断后，采用事实存在=%s 决定是否恢复 runner", async (recorded) => {
    const round = await valid_round();
    const run_id = ulid();
    server.index.insertRun({ run_id, req_id: "REQ-CONTEXT", sdlc_id: "simple-sdlc", sdlc_version: 1, status: "running", started_at: new Date().toISOString(), finished_at: null, error: null, coordination_round_id: round.round_id });
    if (recorded) {
      const session = await server.sessions.open("REQ-CONTEXT");
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.adopted", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round.round_id,
        payload: { round_id: round.round_id, workflow_id: round.workflow_id, node_id: "intake", input_hash: round.input_hash, run_id }, source: { adapter: "test" } });
    }
    await restart();
    if (recorded) {
      await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
      expect(server.runs.activeRunId("REQ-CONTEXT")).toBe(run_id);
      expect((await server.coordination.get("REQ-CONTEXT", round.round_id)).adopted_run_id).toBe(run_id);
    } else {
      expect(await server.runs.getRun(run_id)).toMatchObject({ status: "failed", error: "协调采用事实缺失或版本不匹配，未恢复派发" });
      expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
      expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "workflow.node.entered")).toBe(false);
    }
  });
});

describe("Context Session Agent REST", () => {
  it("终态查询返回时后台槽位已释放，连续发起无需额外等待或固定延迟", async () => {
    for (let index = 0; index < 3; index++) {
      const response = await start(`consecutive-${index}`);
      expect(response.status).toBe(202);
      expect((await done(response.body.round.round_id)).status).toBe("ok");
    }
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(3);
  });
  it("创建异步轮次 → 成功提议 → 事件投影，提议不推进 workflow 或改变文档", async () => {
    const original = await readFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "utf8");
    const response = await start();
    expect(response.status).toBe(202);
    const round = await done(response.body.round.round_id);
    expect(round).toMatchObject({ status: "ok", proposal, req_id: "REQ-CONTEXT", sdlc_id: "simple-sdlc", sdlc_version: 1, workflow_id: "simple-sdlc", driver: "headless:coordinator" });
    expect(round.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(round.agent_configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "utf8")).toBe(original);
    expect((await request("GET", "/api/v1/requirements/REQ-CONTEXT/coordination")).body.rounds).toHaveLength(1);
    const events = await server.sessions.readEvents("REQ-CONTEXT");
    expect(events.filter((event) => event.type.startsWith("coordinator.round.")).map((event) => event.type)).toEqual(["coordinator.round.requested", "coordinator.round.started", "coordinator.round.completed"]);
    for (const event of events.filter((event) => event.type.startsWith("coordinator.round."))) expect(EVENT_PAYLOAD_SCHEMAS[event.type as EventType]?.safeParse(event.payload).success).toBe(true);
    expect(events.some((event) => event.type.startsWith("workflow.node.") || event.type.startsWith("agent.task."))).toBe(false);
    await server.sessions.readLedger("REQ-CONTEXT");
    expect((await request("POST", "/api/v1/doctor")).body.ok).toBe(true);
  });

  it("自定义 ACP 协调 agent 每轮 session/new，最新 PRD 注入而不 session/load", async () => {
    const record_file = join(root, "acp-messages.jsonl");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
      kind: "acp", bin: process.execPath, args: [acp_fixture, "--result-text", JSON.stringify(proposal), "--record", record_file],
    } } }));
    await server.agents.reload();
    const first = await start();
    expect(await done(first.body.round.round_id)).toMatchObject({ status: "ok", proposal, driver: "acp:coordinator" });
    await request("PUT", "/api/v1/requirements/REQ-CONTEXT/docs/prd", { content: "# PRD\nLATEST_ACP_CONTEXT" }, "update-acp-context");
    const second = await start("acp-second-round");
    expect((await done(second.body.round.round_id)).status).toBe("ok");
    const records = (await readFile(record_file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((item) => item.event === "session/new")).toHaveLength(2);
    expect(records.some((item) => item.event === "session/load")).toBe(false);
    const prompts = records.filter((item) => item.event === "prompt");
    expect(prompts[0].text).toContain("CURRENT_CONTEXT");
    expect(prompts[1].text).toContain("LATEST_ACP_CONTEXT");
    expect(prompts[1].text).not.toContain("CURRENT_CONTEXT");
  });

  it("需要幂等键，并发同键请求只创建一轮；重启后重放返回原响应", async () => {
    expect((await request("POST", "/api/v1/requirements/REQ-CONTEXT/coordination", { agent: "coordinator" })).status).toBe(400);
    const results = await Promise.all([start("same-key"), start("same-key"), start("same-key")]);
    expect(results.map((item) => item.status)).toEqual([202, 202, 202]);
    expect(new Set(results.map((item) => item.body.round.round_id)).size).toBe(1);
    await done(results[0]!.body.round.round_id);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(1);
    await restart();
    const replay = await start("same-key");
    expect(replay.body).toEqual(results[0]!.body);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(1);
    expect((await request("POST", "/api/v1/agents/reload", undefined, "same-key")).status).toBe(409);
  });

  it("每需求至多一轮在途协调，取消后可新建", async () => {
    await config(JSON.stringify(proposal), 2_000);
    await server.agents.reload();
    const first = await start();
    expect(first.status).toBe(202);
    expect((await start("another-round")).status).toBe(409);
    const cancelled = await request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${first.body.round.round_id}/cancel`, undefined, "cancel-round");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.round.status).toBe("cancelled");
    await config();
    await server.agents.reload();
    const next = await start("new-round");
    expect(next.status).toBe(202);
    expect((await done(next.body.round.round_id)).status).toBe("ok");
  });

  it("取消先落事实、重复并发取消仅一条请求与终态；超时终态不同", async () => {
    await config(JSON.stringify(proposal), 2_000);
    await server.agents.reload();
    const first = await start();
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).status === "running");
    const url = `/api/v1/requirements/REQ-CONTEXT/coordination/${first.body.round.round_id}/cancel`;
    const results = await Promise.all([request("POST", url, undefined, "cancel-1"), request("POST", url, undefined, "cancel-2")]);
    expect(results.every((item) => item.body.round.status === "cancelled")).toBe(true);
    expect((await request("POST", url, undefined, "cancel-3")).body.round.status).toBe("cancelled");
    const events = (await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => (event.payload as { round_id?: string })?.round_id === first.body.round.round_id);
    expect(events.filter((event) => event.type === "coordinator.round.cancel_requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "coordinator.round.completed")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "coordinator.round.cancel_requested")).toBeLessThan(events.findIndex((event) => event.type === "coordinator.round.completed"));
    const timeout = await start("timeout-round", { timeout_ms: 50 });
    expect((await done(timeout.body.round.round_id)).status).toBe("timeout");
  });

  it("坏输出有 failed/output 事实，修改配置后新轮次恢复", async () => {
    await config("NON_JSON_OUTPUT_DO_NOT_PERSIST");
    await server.agents.reload();
    const failed = await start();
    expect(await done(failed.body.round.round_id)).toMatchObject({ status: "failed", failure_stage: "output", proposal: null });
    expect(JSON.stringify(await server.sessions.readEvents("REQ-CONTEXT"))).not.toContain("NON_JSON_OUTPUT_DO_NOT_PERSIST");
    await config();
    await server.agents.reload();
    const recovered = await start("recovery");
    expect((await done(recovered.body.round.round_id)).status).toBe("ok");
  });

  it("文档在途更新导致 stale，新轮次恢复；重载不改变在途协调 driver", async () => {
    await config(JSON.stringify(proposal), 300);
    await server.agents.reload();
    const first = await start();
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).status === "running");
    expect((await request("PUT", "/api/v1/requirements/REQ-CONTEXT/docs/prd", { content: "# PRD\nUPDATED_INPUT" }, "update-prd")).status).toBe(200);
    expect((await done(first.body.round.round_id)).status).toBe("stale");
    const next = await start("fixed-input");
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", next.body.round.round_id)).status === "running");
    const original_hash = (await server.coordination.get("REQ-CONTEXT", next.body.round.round_id)).agent_configuration_hash;
    const new_proposal = { ...proposal, summary: "NEW_DRIVER_CONFIGURATION" };
    await config(JSON.stringify(new_proposal));
    await server.agents.reload();
    expect(await done(next.body.round.round_id)).toMatchObject({ status: "ok", proposal, agent_configuration_hash: original_hash });
    const new_round = await start("new-config");
    const new_result = await done(new_round.body.round.round_id);
    expect(new_result.proposal).toEqual(new_proposal);
    expect(new_result.agent_configuration_hash).not.toBe(original_hash);
  });

  it("未完成请求在重启后明确 interrupted，取消请求恢复为 cancelled，不重放 driver", async () => {
    const session = await server.sessions.open("REQ-CONTEXT");
    const interrupted_id = ulid();
    const cancelled_id = ulid();
    for (const round_id of [interrupted_id, cancelled_id]) {
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.requested", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round_id,
        payload: { round_id, workflow_id: "simple-sdlc", driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }, source: { adapter: "test" } });
    }
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.cancel_requested", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: cancelled_id, payload: { round_id: cancelled_id }, source: { adapter: "test" } });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", interrupted_id)).toMatchObject({ status: "failed", failure_stage: "interrupted", proposal: null });
    expect(await server.coordination.get("REQ-CONTEXT", cancelled_id)).toMatchObject({ status: "cancelled", failure_stage: "interrupted", proposal: null });
    const before = await server.sessions.readEvents("REQ-CONTEXT");
    expect(before.some((event) => event.type === "coordinator.round.started")).toBe(false);
    await restart();
    expect((await server.sessions.readEvents("REQ-CONTEXT")).length).toBe(before.length);
    const fresh = await start("after-restart");
    expect((await done(fresh.body.round.round_id)).status).toBe("ok");
  });

  it("参数、需求、轮次和归档版本错误具有明确 HTTP 状态", async () => {
    expect((await start("bad-options", { timeout_ms: 0 })).status).toBe(400);
    expect((await start("unknown-property", { execute: "shell" })).status).toBe(400);
    expect((await request("POST", "/api/v1/requirements/NO-REQ/coordination", { agent: "coordinator" }, "missing-req")).status).toBe(404);
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${ulid()}`)).status).toBe(404);
    await server.sdlcs.archive("simple-sdlc", 1);
    expect((await start("archived")).status).toBe(409);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(0);
  });
});
