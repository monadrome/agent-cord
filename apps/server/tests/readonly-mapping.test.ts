import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
const advance = { summary: "按最新需求只读评审", next_action: { kind: "advance", node_id: "review", reason: "按发布约束执行", evidence: [{ source: "workflow", id: "review" }] }, risks: [] };
const waiting = { ...advance, next_action: { kind: "wait", reason: "修复只读映射后执行", evidence: [{ source: "workflow", id: "review" }] } };
let root: string; let server: BuiltServer; let base: string;
async function configure(mapped: boolean, response = advance) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--pid-file", join(root, "worker.pid"),
      "--result-text", "# Human review\nREADONLY_DRAFT", "{{prompt}}", ...(mapped ? ["--readonly", "{{readonly}}"] : [])] },
    coordinator: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(response), "{{prompt}}"] },
  } }));
  if (server) await server.agents.reload();
}
function definition(readonly = true) {
  return stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "readonly-mapping" }, spec: { nodes: [
    { id: "review", artifact: "review.md", run: { agent: "worker", readonly, require_readonly_mapping: true, output: "text", retry: { max_attempts: 3, backoff_ms: 0 } },
      gates: [{ id: "final-human", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() >= deadline) throw new Error("只读映射验收等待超时"); await new Promise(resolve => setTimeout(resolve, 20)); } }
const facts = () => server.sessions.readEvents("REQ-READONLY");
const start = () => api("POST", "/requirements/REQ-READONLY/runs", { sdlc_id: "readonly-mapping" });
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-READONLY/coordination", { agent: "coordinator", sdlc_id: "readonly-mapping" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-READONLY/coordination/${result.body.round.round_id}`;
  await wait(async () => !["pending", "running"].includes((await api("GET", path)).body.round.status));
  return (await api("GET", path)).body.round;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-server-readonly-")); await mkdir(join(root, "cord")); await configure(false);
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  expect((await api("POST", "/sdlcs/readonly-mapping/versions/publish", { yaml: definition() })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-READONLY", title: "只读参数映射门禁", prd: "# PRD\nLATEST_READONLY_A" })).status).toBe(201);
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("只读节点能力准入HTTP闭环", () => {
  it("发布拒绝可写组合；未映射不派发/重试/人审，修复后最新PRD报告等待人工", async () => {
    expect((await api("POST", "/sdlcs/invalid-readonly/versions/publish", { yaml: definition(false) })).status).toBe(400);
    const first = await start(); expect(first.status).toBe(202); await wait(async () => !server.runs.isActive("REQ-READONLY"));
    expect((await api("GET", `/runs/${first.body.run.run_id}`)).body.run.status).toBe("failed");
    expect((await facts()).filter(event => event.type === "agent.task.started")).toHaveLength(1);
    expect((await facts()).find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "configuration", retryable: false });
    await expect(readFile(join(root, "worker.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "cord", "REQ-READONLY", "review.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await server.sessions.listApprovals("REQ-READONLY")).toHaveLength(0);
    await configure(true); expect((await api("PUT", "/requirements/REQ-READONLY/docs/prd", { content: "# PRD\nLATEST_READONLY_B" })).status).toBe(200);
    const fresh = await start(); expect(fresh.status).toBe(202); await wait(async () => (await server.sessions.listApprovals("REQ-READONLY")).length === 1);
    expect((await api("GET", `/runs/${fresh.body.run.run_id}`)).body.run.status).toBe("waiting_human");
    expect((await facts()).filter(event => event.type === "agent.task.started").at(-1)!.payload["prompt_excerpt"]).toContain("LATEST_READONLY_B");
    expect(await readFile(join(root, "worker.pid"), "utf8")).toMatch(/^\d+$/);
    expect(await readFile(join(root, "cord", "REQ-READONLY", "review.md"), "utf8")).toContain("READONLY_DRAFT");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("协调未映射不能advance，合法wait能解释；映射变化使旧提议不可采用", async () => {
    expect(await coordinate()).toMatchObject({ status: "failed", proposal: null });
    await configure(false, waiting); expect(await coordinate()).toMatchObject({ status: "ok", current: true, adoptable: false });
    await configure(true); const current = await coordinate(); expect(current).toMatchObject({ status: "ok", current: true, adoptable: true });
    await configure(false);
    expect((await api("GET", `/requirements/REQ-READONLY/coordination/${current.round_id}`)).body.round).toMatchObject({ current: false, adoptable: false });
    expect((await api("POST", `/requirements/REQ-READONLY/coordination/${current.round_id}/adopt`, {})).status).toBe(409);
    expect(server.runs.listRuns()).toHaveLength(0); await expect(readFile(join(root, "worker.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await configure(true); const fresh = await coordinate(); expect((await api("POST", `/requirements/REQ-READONLY/coordination/${fresh.round_id}/adopt`, {})).status).toBe(202);
    await wait(async () => (await server.sessions.listApprovals("REQ-READONLY")).length === 1);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("派发前热重载保持原resolver；冷恢复保留人工等待，修复后仍不伪造批准", async () => {
    await configure(true); const session = await server.sessions.open("REQ-READONLY"); const append = session.events.append.bind(session.events);
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => { const event = await append(draft); if (draft.type === "agent.task.started") await configure(false); return event; });
    const first = await start(); expect(first.status).toBe(202); await wait(async () => (await server.sessions.listApprovals("REQ-READONLY")).length === 1); spy.mockRestore();
    const pid = await readFile(join(root, "worker.pid"), "utf8"); const guide = await readFile(join(session.dir, "review.md"), "utf8");
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    await wait(async () => (await server.sessions.listApprovals("REQ-READONLY")).length === 1);
    expect((await api("GET", `/runs/${first.body.run.run_id}`)).body.run.status).toBe("waiting_human");
    expect((await facts()).filter(event => event.type === "agent.task.completed")).toHaveLength(1);
    expect(await readFile(join(root, "worker.pid"), "utf8")).toBe(pid); expect(await readFile(join(session.dir, "review.md"), "utf8")).toBe(guide);
    await configure(true); const fresh = await start(); expect(fresh.status).toBe(202);
    await wait(async () => (await server.runs.getRun(fresh.body.run.run_id)).status === "waiting_human");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
