/** 同 ID 的 SDLC 发布版本：真实 worker、审批、协调与索引恢复隔离。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
const proposal = { summary: "新版本先执行 review", next_action: { kind: "advance", node_id: "review", reason: "当前版本尚未执行", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
let root: string;
let server: BuiltServer;
function definition(human = false, prompt = "按当前需求产出计划") {
  return { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "shared-workflow" }, spec: { nodes: [
    { id: "review", artifact: "plan.md", run: { agent: "worker", prompt }, gates: [{ id: "review-gate", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "plan.md" } }], pass: { require: "all", human_confirm: human }, on_fail: "block" }] },
  ] } };
}
async function api(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
  const response = await server.app.inject({ method, url, headers: { ...(method !== "GET" ? { "idempotency-key": ulid() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}
async function wait_for(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("执行版本观察超时"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function publish(id = "revision-sdlc", human = false, prompt?: string) {
  const result = await api("POST", `/api/v1/sdlcs/${id}/versions/publish`, { yaml: YAML.stringify(definition(human, prompt)) });
  expect(result.status).toBe(201); return result.body.version as number;
}
async function start(version: number, id = "revision-sdlc") {
  const result = await api("POST", "/api/v1/requirements/REQ-REVISION/runs", { sdlc_id: id, sdlc_version: version });
  expect(result.status).toBe(202); return result.body.run;
}
async function finished(run_id: string) { await wait_for(async () => (await server.runs.getRun(run_id)).status === "completed" && !server.runs.isActive("REQ-REVISION")); }
async function events() { return server.sessions.readEvents("REQ-REVISION"); }
async function approvals() { return (await api("GET", "/api/v1/requirements/REQ-REVISION/approvals")).body.approvals as Array<Record<string, any>>; }
async function approval() { let current: Record<string, any> | undefined; await wait_for(async () => { current = (await approvals())[0]; return current !== undefined; }); return current!; }
async function restart() { await server.app.close(); server.index.close(); server = await buildApp({ root }); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-workflow-revision-"));
  await mkdir(join(root, "cord"));
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--result-text", "# 最新计划\n执行版本验收", "{{prompt}}"] },
    coordinator: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(proposal), "{{prompt}}"] },
  } }));
  server = await buildApp({ root });
  expect((await api("POST", "/api/v1/requirements", { req_id: "REQ-REVISION", title: "执行版本隔离", prd: "# 最新需求\n版本内恢复，版本间隔离" })).status).toBe(201);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true });
});

describe("发布版本隔离", () => {
  it("同 ID 且定义完全相同的 v1/v2 分别执行，重新 start 同版本复用自己的退出事实", async () => {
    await publish(); await publish();
    const first = await start(1); await finished(first.run_id);
    const second = await start(2); await finished(second.run_id);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
    expect(first.workflow_revision).toMatch(/^[0-9a-f]{64}$/);
    expect(second.workflow_revision).not.toBe(first.workflow_revision);
    const repeated = await start(2); await finished(repeated.run_id);
    expect(repeated.workflow_revision).toBe(second.workflow_revision);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
  });

  it("两个发布名称使用相同 workflow ID 与版本号时，进度仍相互隔离", async () => {
    await publish("first-sdlc"); await publish("second-sdlc");
    const first = await start(1, "first-sdlc"); await finished(first.run_id);
    const second = await start(1, "second-sdlc"); await finished(second.run_id);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
    expect(first.workflow_revision).not.toBe(second.workflow_revision);
  });

  it("相同定义的新版本不能复用旧 worker/人工等待，旧审批不能批准当前版本", async () => {
    await publish("revision-sdlc", true); await publish("revision-sdlc", true);
    await start(1); const old = await approval(); await restart();
    const second = await start(2); const current = await approval();
    expect(current.approval_id).not.toBe(old.approval_id);
    expect(current.workflow_revision).toBe(second.workflow_revision);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
    expect((await api("POST", `/api/v1/requirements/REQ-REVISION/approvals/${old.approval_id}/decide`, { choice: old.options[0] })).status).toBe(409);
    expect((await events()).some((event) => event.type === "human.decision.recorded")).toBe(false);
    expect((await api("POST", `/api/v1/requirements/REQ-REVISION/approvals/${current.approval_id}/decide`, { choice: current.options[0] })).status).toBe(200);
    await finished(second.run_id);
  });

  it("取消旧版本的挂起 run 不会移除当前版本的人工等待", async () => {
    await publish("revision-sdlc", true); await publish("revision-sdlc", true);
    const first = await start(1); await approval(); await restart();
    await start(2); const current = await approval();
    await server.runs.cancel(first.run_id);
    expect((await approvals()).map((item) => item.approval_id)).toEqual([current.approval_id]);
  });

  it("v2 协调快照不继承 v1 退出进度，采用只启动提议绑定版本", async () => {
    await publish(); await publish(); const first = await start(1); await finished(first.run_id);
    const request = await api("POST", "/api/v1/requirements/REQ-REVISION/coordination", { agent: "coordinator", sdlc_id: "revision-sdlc", sdlc_version: 2 });
    expect(request.status).toBe(202);
    let round: Record<string, any> | undefined;
    await wait_for(async () => { round = (await api("GET", `/api/v1/requirements/REQ-REVISION/coordination/${request.body.round.round_id}`)).body.round; return round !== undefined && !["pending", "running"].includes(round.status); });
    expect(round).toMatchObject({ status: "ok", current: true, adoptable: true, proposal });
    expect(round!.workflow_revision).not.toBe(first.workflow_revision);
    const adopted = await api("POST", `/api/v1/requirements/REQ-REVISION/coordination/${round!.round_id}/adopt`, {});
    expect(adopted.status).toBe(202); expect(adopted.body.run.sdlc_version).toBe(2);
    await finished(adopted.body.run.run_id);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
  });

  it("删除派生索引后仍能从启动事实恢复当前自定义 SDLC 版本和完成态", async () => {
    await publish(); await publish(); const run = await start(2); await finished(run.run_id);
    await server.app.close(); server.index.close(); await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    server = await buildApp({ root });
    const timeline = (await api("GET", "/api/v1/requirements/REQ-REVISION/timeline")).body.timeline;
    expect(timeline).toMatchObject({ sdlc_id: "revision-sdlc", sdlc_version: 2, run: { run_id: run.run_id, status: "completed" }, nodes: [{ node_id: "review", status: "exited" }] });
    expect((await api("GET", "/api/v1/requirements/REQ-REVISION")).body.requirement.status).toBe("completed");
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
  });

  it("发布定义被外部改动时拒绝恢复原 run，不把旧审批用于改动后的定义", async () => {
    await publish("revision-sdlc", true); const run = await start(1); await approval();
    const file = join(root, "cord", ".sdlc", "revision-sdlc", "v1.yaml");
    expect(await readFile(file, "utf8")).toContain("shared-workflow");
    await writeFile(file, YAML.stringify(definition(true, "外部改动后的定义")));
    await restart();
    expect((await server.runs.getRun(run.run_id)).status).toBe("failed");
    expect(server.runs.isActive("REQ-REVISION")).toBe(false);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
  });

  it("无版本旧退出/审批不属于新版，旧运行登记不能自动派发", async () => {
    await publish();
    const session = await server.sessions.open("REQ-REVISION");
    for (const [type, payload] of [
      ["workflow.node.exited", { workflow_id: "shared-workflow", node_id: "review" }],
      ["gate.waiting", { workflow_id: "shared-workflow", node_id: "review", gate_id: "review-gate", options: ["确认放行", "拒绝放行"] }],
    ] as const) await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "system", id: "legacy" }, correlation_id: "review", payload, source: { adapter: "test" } });
    const legacy_id = ulid();
    server.index.insertRun({ run_id: legacy_id, req_id: session.req_id, sdlc_id: "revision-sdlc", sdlc_version: 1, status: "running", started_at: new Date().toISOString(), finished_at: null, error: null });
    await restart();
    expect((await server.runs.getRun(legacy_id)).status).toBe("failed");
    expect(server.runs.isActive(session.req_id)).toBe(false);
    expect(await approvals()).toEqual([]);
    const run = await start(1); await finished(run.run_id);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
  });

  it("同版本等待重启不重复 worker，审批 ID 保持并可消费", async () => {
    await publish("revision-sdlc", true); const run = await start(1); const old = await approval();
    await restart();
    expect((await approval()).approval_id).toBe(old.approval_id);
    expect((await api("POST", `/api/v1/requirements/REQ-REVISION/approvals/${old.approval_id}/decide`, { choice: old.options[0] })).status).toBe(200);
    await wait_for(async () => !server.runs.isActive("REQ-REVISION"));
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
    expect((await server.runs.latestRun("REQ-REVISION"))?.workflow_revision).toBe(run.workflow_revision);
  });

  it("启动绑定追加失败不派发，释放槽位，修复后重新启动可完成", async () => {
    await publish(); const session = await server.sessions.open("REQ-REVISION");
    const real_append = session.events.append.bind(session.events);
    const failure = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "workflow.run.started" ? Promise.reject(new Error("binding store unavailable")) : real_append(draft));
    expect((await api("POST", "/api/v1/requirements/REQ-REVISION/runs", { sdlc_id: "revision-sdlc", sdlc_version: 1 })).status).toBe(500);
    expect(server.runs.isActive("REQ-REVISION")).toBe(false);
    expect(server.runs.listRuns()[0]?.status).toBe("failed");
    expect((await events()).some((event) => event.type === "workflow.node.entered")).toBe(false);
    failure.mockRestore(); const run = await start(1); await finished(run.run_id);
  });

  it("当前版本由因果启动事实确定，不被更晚墙钟的未绑定登记覆盖", async () => {
    await publish(); await publish(); const first = await start(1); await finished(first.run_id); const second = await start(2); await finished(second.run_id);
    server.index.insertRun({ run_id: ulid(), req_id: "REQ-REVISION", sdlc_id: "revision-sdlc", sdlc_version: 1, status: "failed", started_at: "2099-01-01T00:00:00.000Z", finished_at: null, error: "未落启动事实", workflow_revision: first.workflow_revision });
    expect((await server.runs.latestRun("REQ-REVISION"))?.run_id).toBe(second.run_id);
    expect((await api("GET", "/api/v1/requirements/REQ-REVISION/timeline")).body.timeline.sdlc_version).toBe(2);
  });

  it("部分索引丢失可重建历史终态，不把较早版本恢复成当前 run", async () => {
    await publish(); await publish(); const first = await start(1); await finished(first.run_id); const second = await start(2); await finished(second.run_id);
    const db = new DatabaseSync(join(root, "cord", ".index", "server-index.sqlite"));
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(first.run_id); db.close();
    await restart();
    expect((await server.runs.latestRun("REQ-REVISION"))?.run_id).toBe(second.run_id);
    expect((await server.runs.getRun(first.run_id)).status).toBe("completed");
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
  });

  it("当前版本人工等待在整个索引删除后恢复，保持审批 ID 和已完成 worker", async () => {
    await publish("revision-sdlc", true); await publish("revision-sdlc", true);
    const run = await start(2); const pending = await approval();
    await server.app.close(); server.index.close(); await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    server = await buildApp({ root });
    expect((await approval()).approval_id).toBe(pending.approval_id);
    expect((await server.runs.latestRun("REQ-REVISION"))?.run_id).toBe(run.run_id);
    expect((await api("POST", `/api/v1/requirements/REQ-REVISION/approvals/${pending.approval_id}/decide`, { choice: pending.options[0] })).status).toBe(200);
    await wait_for(async () => !server.runs.isActive("REQ-REVISION"));
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
  });

  it("登记后、启动事实落盘前中断不会派发或覆盖已有当前版本", async () => {
    await publish(); const first = await start(1); await finished(first.run_id);
    const interrupted = ulid();
    server.index.insertRun({ run_id: interrupted, req_id: "REQ-REVISION", sdlc_id: "revision-sdlc", sdlc_version: 1, workflow_revision: first.workflow_revision,
      status: "running", started_at: new Date().toISOString(), finished_at: null, error: null });
    await restart();
    expect((await server.runs.getRun(interrupted)).status).toBe("failed");
    expect((await server.runs.latestRun("REQ-REVISION"))?.run_id).toBe(first.run_id);
    expect(server.runs.isActive("REQ-REVISION")).toBe(false);
    expect((await events()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
  });

  it("启动事实的 workflow 标识必须匹配绑定定义，否则恢复失败", async () => {
    await publish(); const versioned = await server.sdlcs.get("revision-sdlc", 1); const run_id = ulid();
    server.index.insertRun({ run_id, req_id: "REQ-REVISION", sdlc_id: "revision-sdlc", sdlc_version: 1, workflow_revision: versioned.workflow_revision,
      status: "running", started_at: new Date().toISOString(), finished_at: null, error: null });
    const session = await server.sessions.open("REQ-REVISION");
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.started", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: run_id,
      payload: { run_id, workflow_id: "WRONG-WORKFLOW", workflow_revision: versioned.workflow_revision, sdlc_id: "revision-sdlc", sdlc_version: 1 }, source: { adapter: "test" } });
    await restart();
    expect((await server.runs.getRun(run_id)).status).toBe("failed");
    expect((await events()).some((event) => event.type === "workflow.node.entered")).toBe(false);
  });
});
