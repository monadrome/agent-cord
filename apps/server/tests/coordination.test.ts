/** 独立协调 API：真实 Fastify + 离线 headless 子进程，验证幂等、固定配置、取消和恢复。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

describe("Context Session Agent REST", () => {
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
