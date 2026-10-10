/** 版本化审批：需求变化、共识推翻、重启与落盘决策恢复（ADR-0030）。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { ApprovalItem } from "@agent-cord/server/contracts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
let root: string;
let server: BuiltServer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-approval-fresh-"));
  await mkdir(join(root, "cord"));
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--result-text", "# CURRENT_DRAFT", "{{prompt}}"] } } }));
  server = await buildApp({ root });
});
afterEach(async () => {
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

async function api(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
  const response = await server.app.inject({ method, url, headers: { ...(method !== "GET" ? { "idempotency-key": ulid() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}
async function wait_for(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("审批观察超时"); await new Promise((resolve) => setTimeout(resolve, 15)); }
}
async function publish(agent = false, ref = "anchors-present") {
  const yaml = YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "approval-fresh" }, spec: { nodes: [{ id: "review", ...(agent ? { artifact: "plan.md", run: { agent: "worker" } } : {}), gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref }], pass: { require: "all", human_confirm: true }, on_fail: "block" }] }] } });
  expect((await api("POST", "/api/v1/sdlcs/approval-fresh/versions/publish", { yaml })).status).toBe(201);
}
async function create() {
  expect((await api("POST", "/api/v1/requirements", { req_id: "REQ-FRESH", title: "审批版本测试", prd: "# VERSION_ONE" })).status).toBe(201);
}
async function start() {
  const response = await api("POST", "/api/v1/requirements/REQ-FRESH/runs", { sdlc_id: "approval-fresh" });
  expect(response.status).toBe(202);
  return response.body.run.run_id as string;
}
async function approval(exclude?: string): Promise<ApprovalItem> {
  let found: ApprovalItem | undefined;
  await wait_for(async () => {
    found = (await server.sessions.listApprovals("REQ-FRESH")).find((item) => item.approval_id !== exclude);
    return found !== undefined;
  });
  return found!;
}
async function decide(item: ApprovalItem, choice = item.options[0]!) {
  return api("POST", `/api/v1/requirements/REQ-FRESH/approvals/${item.approval_id}/decide`, { choice });
}
async function finished(run_id: string, expected = "completed") {
  await wait_for(async () => (await server.runs.getRun(run_id)).status === expected && !server.runs.isActive("REQ-FRESH"));
}
async function append(type: string, payload: Record<string, unknown>) {
  const session = await server.sessions.open("REQ-FRESH");
  await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null, payload, source: { adapter: "test" } });
}
async function events() { return (await server.sessions.open("REQ-FRESH")).events.readOrdered(); }
async function restart() { await server.app.close(); server.index.close(); server = await buildApp({ root }); }

describe("审批依据新鲜度", () => {
  it("不同 workflow 的同名 gate 等待独立，迟到的旧版本失效不删除新等待", async () => {
    await create();
    const wait = async (workflow_id: string) => {
      await append("gate.waiting", { workflow_id, node_id: "review", gate_id: "shared", question: "版本测试", options: ["确认放行", "拒绝放行"], kind: "human_confirm", evaluation_hash: "a".repeat(64) });
      return (await events()).at(-1)!.event_id;
    };
    const old_a = await wait("workflow-a");
    const b = await wait("workflow-b");
    expect(await server.sessions.listApprovals("REQ-FRESH")).toHaveLength(2);
    const new_a = await wait("workflow-a");
    await append("gate.invalidated", { workflow_id: "workflow-a", node_id: "review", gate_id: "shared", waiting_event_id: old_a, reason: "迟到的失效" });
    expect((await server.sessions.listApprovals("REQ-FRESH")).map((item) => item.approval_id).sort()).toEqual([b, new_a].sort());
    await append("gate.invalidated", { workflow_id: "workflow-b", node_id: "review", gate_id: "shared", waiting_event_id: b, reason: "当前版本失效" });
    expect((await server.sessions.listApprovals("REQ-FRESH")).map((item) => item.approval_id)).toEqual([new_a]);
  });

  it("PRD 更新后旧审批返回 409，重新发起当前版本，未记录旧放行", async () => {
    await publish(); await create(); const run = await start(); const old = await approval();
    await api("PUT", "/api/v1/requirements/REQ-FRESH/docs/prd", { content: "# VERSION_TWO" });
    expect((await decide(old)).status).toBe(409);
    const next = await approval(old.approval_id);
    expect(next.approval_id).not.toBe(old.approval_id);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await decide(old)).status).toBe(409);
    expect((await decide(next)).status).toBe(200);
    await finished(run);
    expect((await events()).filter((event) => event.type === "gate.invalidated")).toHaveLength(1);
  });

  it("可写 worker 的输入更新后先重跑 worker，再显示新的产物审批", async () => {
    await publish(true); await create(); const run = await start(); const old = await approval();
    await api("PUT", "/api/v1/requirements/REQ-FRESH/docs/prd", { content: "# VERSION_TWO" });
    expect((await decide(old)).status).toBe(409);
    const next = await approval(old.approval_id);
    const tasks = (await events()).filter((event) => event.type === "agent.task.completed");
    expect(tasks).toHaveLength(2);
    const started = (await events()).filter((event) => event.type === "agent.task.started");
    expect(started.at(-1)?.payload).toMatchObject({ prompt_excerpt: expect.stringContaining("VERSION_TWO") });
    expect((await decide(next)).status).toBe(200); await finished(run);
  });

  it("等待期间共识推翻，拒绝旧选择并机器阻断，没有伪造人工拒绝", async () => {
    await publish(false, "ledger-has-confirmed"); await create();
    await append("ledger.entry.proposed", { entry_id: "C-1", title: "共识", anchors: [{ kind: "doc", anchor: "prd.md" }] });
    await append("ledger.entry.confirmed", { entry_id: "C-1" });
    const run = await start(); const old = await approval();
    await append("ledger.entry.overturned", { entry_id: "C-1", reason: "最新证据推翻" });
    expect((await decide(old)).status).toBe(409); await finished(run, "blocked");
    expect((await server.sessions.listApprovals("REQ-FRESH"))).toEqual([]);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    const resolution = (await events()).find((event) => event.type === "gate.resolved");
    expect(resolution?.payload).toMatchObject({ result: "block", human_confirmed: false });
  });

  it("旧静态审批编码被拒绝，不能绕过等待版本绑定", async () => {
    await publish(); await create(); await start(); await approval();
    const legacy = Buffer.from("review/human-review").toString("base64url");
    const response = await api("POST", `/api/v1/requirements/REQ-FRESH/approvals/${legacy}/decide`, { choice: "确认放行" });
    expect(response.status).toBe(409);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("同等待版本并发选择只允许一次落盘", async () => {
    await publish(); await create(); const run = await start(); const item = await approval();
    const responses = await Promise.all([decide(item), decide(item)]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    await finished(run);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(1);
  });

  it("审批输入不可读时 409 且不记录放行，修复原文后原审批仍可消费", async () => {
    await publish(); await create(); const run = await start(); const item = await approval();
    const path = join(root, "cord", "REQ-FRESH", "prd.md");
    await rm(path); await mkdir(path);
    expect((await decide(item)).status).toBe(409);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    await rm(path, { recursive: true }); await writeFile(path, "# VERSION_ONE");
    expect((await decide(item)).status).toBe(200); await finished(run);
  });

  it("重启后输入变更，旧审批失效并重跑 worker，旧选择不进入暂存", async () => {
    await publish(true); await create(); await start(); const old = await approval();
    await restart();
    await api("PUT", "/api/v1/requirements/REQ-FRESH/docs/prd", { content: "# AFTER_RESTART" });
    expect((await decide(old)).status).toBe(409);
    const next = await approval(old.approval_id);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await decide(next)).status).toBe(200);
    await wait_for(async () => !server.runs.isActive("REQ-FRESH"));
    expect(server.runs.listRuns("REQ-FRESH")[0]?.status).toBe("completed");
  });

  it.each([false, true])("落盘选择未消费时重启，changed=%s：只消费匹配依据的选择", async (changed) => {
    await publish(); await create(); const original = await start(); const item = await approval();
    const waiting = (await events()).find((event) => event.event_id === item.approval_id)!;
    // 固定未消费窗口：等待事实可见时，旧 executor 仍可能尚未进入 ask。
    await server.runs.close();
    await append("human.decision.recorded", { ...(waiting.payload as Record<string, unknown>), waiting_event_id: item.approval_id, chosen: "确认放行", chosen_index: 0, timeout_ms: null, default_index: 0, fallback: null, raw_input: null });
    if (changed) await api("PUT", "/api/v1/requirements/REQ-FRESH/docs/prd", { content: "# AFTER_RECORDED_DECISION" });
    await restart();
    if (changed) {
      const next = await approval(item.approval_id);
      expect((await decide(next)).status).toBe(200);
    }
    await finished(original);
    expect((await events()).filter((event) => event.type === "gate.resolved")).toHaveLength(1);
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(changed ? 2 : 1);
  });

  it("waiting_human 登记后选择落盘又重启，仍可从事实恢复消费", async () => {
    await publish(); await create(); await start(); const item = await approval();
    await restart();
    expect(server.runs.listRuns("REQ-FRESH")[0]?.status).toBe("waiting_human");
    const waiting = (await events()).find((event) => event.event_id === item.approval_id)!;
    await append("human.decision.recorded", { ...(waiting.payload as Record<string, unknown>), waiting_event_id: item.approval_id, chosen: "确认放行", chosen_index: 0, timeout_ms: null, default_index: 0, fallback: null, raw_input: null });
    await restart();
    await wait_for(async () => !server.runs.isActive("REQ-FRESH"));
    expect(server.runs.listRuns("REQ-FRESH")[0]?.status).toBe("completed");
    expect((await events()).filter((event) => event.type === "human.decision.recorded")).toHaveLength(1);
  });
});
