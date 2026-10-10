import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-acp-agent.mjs", import.meta.url));
const advance = { summary: "按当前配置实现Draft", next_action: { kind: "advance", node_id: "deliver", reason: "当前需求明确", evidence: [{ source: "workflow", id: "deliver" }] }, risks: [] };
let root: string; let server: BuiltServer;
async function configure(label: string, response = advance, transport: "headless" | "acp" = "headless") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    coordinator: { kind: transport, bin: process.execPath, args: transport === "headless" ? [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(response), "{{prompt}}"]
      : [acp_fixture, "--no-tools", "--result-text", JSON.stringify(response)], },
    writer: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--result-text", label, "{{prompt}}"], env: { PRIVATE_ENV: "SECRET_ENV_MARKER" } },
  } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST", path: string, payload?: unknown) {
  const response = await server.app.inject({ method, url: "/api/v1" + path, ...(method === "POST" ? { headers: { "idempotency-key": ulid() } } : {}), ...(payload === undefined ? {} : { payload }) });
  return { status: response.statusCode, body: response.json() };
}
async function wait(test: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await test()) { if (Date.now() > deadline) throw new Error("Agent上下文等待超时"); await new Promise(resolve => setTimeout(resolve, 20)); } }
const facts = async () => server.sessions.readEvents("REQ-AGENTS");
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-AGENTS/coordination", { agent: "coordinator", sdlc_id: "agent-context" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-AGENTS/coordination/${result.body.round.round_id}`;
  await wait(async () => !["pending", "running"].includes((await api("GET", path)).body.round.status));
  return (await api("GET", path)).body.round;
}
const adopt = (id: string) => api("POST", `/requirements/REQ-AGENTS/coordination/${id}/adopt`, {});
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-coordination-agents-")); await mkdir(join(root, "cord")); await configure("DRAFT_A");
  server = await buildApp({ root });
  await server.sdlcs.publish("agent-context", stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "agent-context" }, spec: { nodes: [
    { id: "deliver", artifact: "plan.md", run: { agent: "writer" }, gates: [{ id: "review", attach: { node: "deliver", when: "post" }, role: {},
      checks: [{ ref: "file-nonempty", with: { path: "plan.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } }));
  expect((await api("POST", "/requirements", { req_id: "REQ-AGENTS", title: "流程Agent配置", prd: "# PRD\n依据当前定义交付Draft" })).status).toBe(201);
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("协调流程Agent身份", () => {
  it.each(["headless", "acp"] as const)("%s 真实prompt带身份/能力，换worker后旧提议失效，新轮次恢复且等待人审", async transport => {
    await configure("DRAFT_A", advance, transport); const worker = server.agents.resolver()("coordinator"); const original = worker.run.bind(worker); const prompts: string[] = [];
    vi.spyOn(worker, "run").mockImplementation(async function* (task) { prompts.push(task.prompt); yield* original(task); });
    const first = await coordinate(); expect(first).toMatchObject({ status: "ok", current: true, adoptable: true, agent_context_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(prompts[0]).toContain("workflow_agents:"); expect(prompts[0]).toContain('"agent":"writer"'); expect(prompts[0]).not.toContain("SECRET_ENV_MARKER");
    const coor_hash = first.agent_configuration_hash; await configure("DRAFT_B", advance, transport);
    expect((await server.coordination.get("REQ-AGENTS", first.round_id))).toMatchObject({ current: false, adoptable: false });
    expect((await adopt(first.round_id)).status).toBe(409); expect(server.runs.listRuns()).toHaveLength(0);
    const fresh = await coordinate(); expect(fresh).toMatchObject({ current: true, adoptable: true, agent_configuration_hash: coor_hash }); expect(fresh.agent_context_hash).not.toBe(first.agent_context_hash);
    expect((await adopt(fresh.round_id)).status).toBe(202); await wait(async () => (await server.sessions.listApprovals("REQ-AGENTS")).length === 1);
    expect(await readFile(join(root, "cord", "REQ-AGENTS", "plan.md"), "utf8")).toContain("DRAFT_B");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("采用A/B/A窗口不能校验A而执行B，记录后热重载保持已核验A", async () => {
    const first = await coordinate(); const resolver_a = server.agents.resolver();
    await configure("DRAFT_B"); const resolver_b = server.agents.resolver(); await configure("DRAFT_A");
    let calls = 0; const spy = vi.spyOn(server.agents, "resolver").mockImplementation(() => ++calls === 2 ? resolver_b : resolver_a);
    const result = await adopt(first.round_id); spy.mockRestore();
    expect(result.status).toBe(409); expect((await facts()).some(event => event.type === "agent.task.started")).toBe(false);
    const second = await coordinate(); const session = await server.sessions.open("REQ-AGENTS"); const append = session.events.append.bind(session.events);
    const reload = vi.spyOn(session.events, "append").mockImplementation(async draft => { const event = await append(draft); if (draft.type === "coordinator.round.adopted") await configure("DRAFT_B"); return event; });
    expect((await adopt(second.round_id)).status).toBe(202); reload.mockRestore();
    await wait(async () => (await server.sessions.listApprovals("REQ-AGENTS")).length === 1);
    expect(await readFile(join(session.dir, "plan.md"), "utf8")).toContain("DRAFT_A");
  });

  it("未知worker只能生成wait，修复前不能advance；完整摘要缺失的旧提议不可采用", async () => {
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { coordinator: { kind: "headless", bin: process.execPath,
      args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(advance), "{{prompt}}"] } } })); await server.agents.reload();
    expect(await coordinate()).toMatchObject({ status: "failed", proposal: null });
    const waiting = { ...advance, next_action: { kind: "wait", reason: "writer未配置", evidence: [{ source: "workflow", id: "deliver" }] } };
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { coordinator: { kind: "headless", bin: process.execPath,
      args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(waiting), "{{prompt}}"] } } })); await server.agents.reload();
    expect(await coordinate()).toMatchObject({ status: "ok", current: true, adoptable: false });
    await configure("DRAFT_A"); const first = await coordinate(); const session = await server.sessions.open("REQ-AGENTS"); const read = session.events.readOrderedStrict!.bind(session.events);
    const spy = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => (await read()).map(event => ["coordinator.round.started", "coordinator.round.completed"].includes(event.type) ? { ...event, payload: { ...event.payload, agent_context_hash: undefined } } : event));
    try { expect(await server.coordination.get("REQ-AGENTS", first.round_id)).toMatchObject({ current: false, adoptable: false }); } finally { spy.mockRestore(); }
  });

  it.each([false, true])("采用已落盘/派发前冷恢复只允许绑定worker身份（changed=%s）", async changed => {
    const round = await coordinate(); const session = await server.sessions.open("REQ-AGENTS"); const append = session.events.append.bind(session.events);
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await append(draft); if (draft.type === "coordinator.round.adopted") throw new Error("记录后派发前中断"); return result;
    });
    expect((await adopt(round.round_id)).status).toBe(500); spy.mockRestore();
    const run_id = (await facts()).find(event => event.type === "workflow.run.started")!.payload["run_id"] as string;
    expect((await facts()).some(event => event.type === "agent.task.started")).toBe(false);
    // 模拟宿主未完成登记收尾：启动/采用事实已落盘，操作索引仍在running。
    server.index.setRunStatus(run_id, "running");
    if (changed) await configure("DRAFT_B");
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    if (changed) {
      expect(await server.runs.getRun(run_id)).toMatchObject({ status: "failed", error: expect.stringContaining("身份已变化") });
      expect((await facts()).some(event => event.type === "agent.task.started")).toBe(false);
      const fresh = await coordinate(); expect((await adopt(fresh.round_id)).status).toBe(202);
    }
    await wait(async () => (await server.sessions.listApprovals("REQ-AGENTS")).length === 1);
    expect(await readFile(join(root, "cord", "REQ-AGENTS", "plan.md"), "utf8")).toContain(changed ? "DRAFT_B" : "DRAFT_A");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it.each(["missing_hash", "wrong_source", "wrong_node"])("恢复依据%s不能仅靠匹配输入摘要派发worker", async mode => {
    const round = await coordinate(); const session = await server.sessions.open("REQ-AGENTS"); const append = session.events.append.bind(session.events);
    const stopped = vi.spyOn(session.events, "append").mockImplementation(async draft => { const event = await append(draft); if (draft.type === "coordinator.round.adopted") throw new Error("派发前中断"); return event; });
    expect((await adopt(round.round_id)).status).toBe(500); stopped.mockRestore();
    const run_id = (await facts()).find(event => event.type === "workflow.run.started")!.payload["run_id"] as string;
    server.index.setRunStatus(run_id, "running");
    const read = session.events.readOrdered.bind(session.events);
    const damaged = vi.spyOn(session.events, "readOrdered").mockImplementation(async () => (await read()).map(event => {
      if (event.type !== "coordinator.round.completed") return event;
      if (mode === "wrong_source") return { ...event, actor: { kind: "human" as const, id: "test" } };
      return { ...event, payload: { ...event.payload, ...(mode === "missing_hash" ? { agent_context_hash: undefined } : { proposal: { ...advance, next_action: { ...advance.next_action, node_id: "other" } } }) } };
    }));
    try { expect(await server.runs.recover(run_id)).toEqual([]); } finally { damaged.mockRestore(); }
    expect(await server.runs.getRun(run_id)).toMatchObject({ status: "failed", error: expect.stringContaining("来源缺失") });
    expect((await facts()).filter(event => event.type === "agent.task.started" || event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
