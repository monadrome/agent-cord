import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-active-status-")); await mkdir(join(root, "cord"));
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "headless", bin: process.execPath,
    args: [fixture, "--mode", "claude", "--no-tools", "--sleep", "600", "--result-text", "# CURRENT_DRAFT", "{{prompt}}"] } } }));
  server = await buildApp({ root }); base = await server.app.listen({ port: 0, host: "127.0.0.1" });
});
afterEach(async () => { vi.restoreAllMocks(); await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });
async function api(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() > deadline) throw new Error("run状态等待超时"); await new Promise(resolve => setTimeout(resolve, 15)); } }
async function prepare(worker = false) {
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "active-status" }, spec: { nodes: [
    { id: "review", artifact: "prd.md", gates: [{ id: "human", attach: { node: "review", when: "post" }, role: {}, checks: [{ ref: "file-nonempty", with: { path: "prd.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "work", depends_on: ["review"], ...(worker ? { artifact: "plan.md", run: { agent: "worker" } } : {}) },
  ] } });
  expect((await api("POST", "/sdlcs/active-status/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-STATUS", title: "活动等待状态", prd: "# CURRENT_REQUIREMENT" })).status).toBe(201);
}
async function start() { const result = await api("POST", "/requirements/REQ-STATUS/runs", { sdlc_id: "active-status" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function approvals() { return (await api("GET", "/requirements/REQ-STATUS/approvals")).body.approvals; }

describe("活动 run REST等待投影", () => {
  it("waiting落盘/ask前窗口，run/列表/需求active_run/协调共用等待事实且不写索引", async () => {
    await prepare(); const session = await server.sessions.open("REQ-STATUS"); const append = session.events.append.bind(session.events);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await append(draft); if (draft.type === "gate.waiting") { entered(); await held; } return result;
    });
    const run_id = await start(); await started;
    try {
      expect(server.index.getRun(run_id)?.status).toBe("running");
      const before = await session.events.readOrderedStrict!();
      expect((await api("GET", `/runs/${run_id}`)).body.run).toMatchObject({ status: "waiting_human", finished_at: null });
      expect((await api("GET", "/requirements/REQ-STATUS/runs")).body.runs[0].status).toBe("waiting_human");
      expect((await api("GET", "/requirements/REQ-STATUS")).body.requirement.active_run.status).toBe("waiting_human");
      const binding = await server.sdlcs.get("active-status", 1);
      expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).run).toMatchObject({ status: "waiting_human", active: true });
      expect(server.index.getRun(run_id)?.status).toBe("running");
      expect(await session.events.readOrderedStrict!()).toEqual(before);
    } finally { release(); spy.mockRestore(); }
    await wait(async () => (await approvals()).length === 1);
    expect((await api("POST", `/runs/${run_id}/cancel`, {})).body.run.status).toBe("cancelled");
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("cancelled");
  });

  it("有效选择后下一个worker显示running，旧等待不污染执行，完成后保持终态", async () => {
    await prepare(true); const run_id = await start(); await wait(async () => (await approvals()).length === 1);
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("waiting_human");
    const item = (await approvals())[0]; expect((await api("POST", `/requirements/REQ-STATUS/approvals/${item.approval_id}/decide`, { choice: item.options[0] })).status).toBe(200);
    const session = await server.sessions.open("REQ-STATUS");
    await wait(async () => (await session.events.readOrdered()).some(event => event.type === "agent.task.started"));
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("running");
    const binding = await server.sdlcs.get("active-status", 1);
    expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).run).toMatchObject({ status: "running", active: true });
    await wait(async () => !server.runs.isActive("REQ-STATUS")); expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("completed");
  });

  it("活动事件读取失败拒绝run/列表查询，恢复后原审批可读取而不产生新事实", async () => {
    await prepare(); const run_id = await start(); await wait(async () => (await approvals()).length === 1);
    const session = await server.sessions.open("REQ-STATUS"); const before = await session.events.readOrderedStrict!();
    const spy = vi.spyOn(session.events, "readOrderedStrict").mockRejectedValue(new Error("事件暂不可读取"));
    try {
      expect((await api("GET", `/runs/${run_id}`)).status).toBe(500);
      expect((await api("GET", "/requirements/REQ-STATUS/runs")).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("waiting_human");
    expect(await session.events.readOrderedStrict!()).toEqual(before);
  });

  it("审批失效到新等待之间显示正在重检，新等待恢复waiting_human而不记录旧选择", async () => {
    await prepare(); const run_id = await start(); await wait(async () => (await approvals()).length === 1);
    const item = (await approvals())[0]; const session = await server.sessions.open("REQ-STATUS"); const append = session.events.append.bind(session.events);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await append(draft); if (draft.type === "gate.invalidated") { entered(); await held; } return result;
    });
    expect((await api("PUT", "/requirements/REQ-STATUS/docs/prd", { content: "# CHANGED_REQUIREMENT" })).status).toBe(200);
    const deciding = api("POST", `/requirements/REQ-STATUS/approvals/${item.approval_id}/decide`, { choice: item.options[0] });
    await started;
    try { expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("running"); }
    finally { release(); spy.mockRestore(); }
    expect((await deciding).status).toBe(409);
    await wait(async () => (await approvals()).some((entry: { approval_id: string }) => entry.approval_id !== item.approval_id));
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("waiting_human");
    expect((await session.events.readOrdered()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("活动读取期间取消，迟到run/列表响应保留取消登记，不复活旧running", async () => {
    await prepare(); const run_id = await start(); await wait(async () => (await approvals()).length === 1);
    const session = await server.sessions.open("REQ-STATUS"); const read = session.events.readOrderedStrict!.bind(session.events);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(session.events, "readOrderedStrict").mockImplementationOnce(async () => {
      const events = await read(); entered(); await held; return events;
    });
    const reading = api("GET", `/runs/${run_id}`); await started;
    try { expect((await api("POST", `/runs/${run_id}/cancel`, {})).body.run.status).toBe("cancelled"); }
    finally { release(); spy.mockRestore(); }
    expect((await reading).body.run.status).toBe("cancelled");
    expect((await server.runs.readRuns("REQ-STATUS"))[0]?.status).toBe("cancelled");
  });

  it("冷恢复和索引重建保留等待，不启动worker或伪造人工决定", async () => {
    await prepare(true); const run_id = await start(); await wait(async () => (await approvals()).length === 1);
    const item = (await approvals())[0];
    await server.app.close(); server.index.close(); await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    server = await buildApp({ root }); base = await server.app.listen({ port: 0, host: "127.0.0.1" });
    expect((await api("GET", `/runs/${run_id}`)).body.run.status).toBe("waiting_human");
    expect((await api("GET", "/requirements/REQ-STATUS/runs")).body.runs[0].status).toBe("waiting_human");
    expect((await approvals())[0].approval_id).toBe(item.approval_id);
    const facts = await server.sessions.readEvents("REQ-STATUS");
    expect(facts.filter(event => event.type === "agent.task.started" || event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
