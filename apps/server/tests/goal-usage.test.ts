import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient } from "../../console/src/api.js";
import type { GoalUsageBudget } from "agent-cord";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-supervisor.mjs", import.meta.url));
let root: string; let server: BuiltServer | undefined; let seq = 0;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-usage-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });
async function api(method: "GET" | "POST", url: string, payload?: unknown) {
  const response = await server!.app.inject({ method, url: "/api/v1" + url, ...(method === "POST" ? { headers: { "idempotency-key": "usage-" + seq++ } } : {}), ...(payload === undefined ? {} : { payload }) });
  return { status: response.statusCode, body: response.json() };
}
const req = "/requirements/REQ-USAGE";
async function facts() { return (await server!.sessions.open("REQ-USAGE")).events.readOrdered(); }
async function waitFor(check: () => Promise<boolean>) { const until = Date.now() + 12000; while (!await check()) { if (Date.now() > until) throw Error("资源观察等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function restart() { await server!.app.close(); server!.index.close(); server = await buildApp({ root }); }
async function prepare(protocol: "headless" | "acp", budget: GoalUsageBudget | undefined, usage_mode = "tokens") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: protocol, bin: process.execPath, args: [worker, ...(protocol === "acp" ? ["--acp"] : []), "--usage-mode", usage_mode, ...(protocol === "headless" ? ["{{prompt}}"] : [])] },
    supervisor: { kind: "headless", bin: process.execPath, args: [supervisor, "{{prompt}}"] },
  } }));
  server = await buildApp({ root });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "usage-flow" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], max_attempts: 3, timeout_ms: 30000, no_progress_limit: 3,
      supervisor_agent: "supervisor", ...(budget === undefined ? {} : { usage_budget: budget }),
      checks: [{ id: "value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"], timeout_ms: 2000 }],
    } }, gates: [{ id: "human-review", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "verification-passed", with: { verification_id: "value" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["deliver"] },
  ] } });
  expect((await api("POST", "/sdlcs/usage-flow/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-USAGE", title: "Goal 资源观察", prd: "# 目标\nvalue.txt 必须为 fixed，交付宿主实测与指南。" })).status).toBe(201);
}
async function start() { const response = await api("POST", req + "/runs", { sdlc_id: "usage-flow" }); expect(response.status).toBe(202); return response.body.run.run_id as string; }
async function resources() { const response = await api("GET", req + "/goal-usage"); expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body.goals; }

describe("Goal 当前资源观察", () => {
  it.each(["headless", "acp"] as const)("%s 累计 token 到精确上限合法 ready，资源/模型投影/冷恢复/人审共用证据", async protocol => {
    await prepare(protocol, { max_input_tokens: 12, max_output_tokens: 4 });
    expect(await resources()).toEqual([]);
    const run_id = await start(); await waitFor(async () => (await api("GET", req + "/approvals")).body.approvals.length === 1);
    expect((await resources())[0]).toMatchObject({ run_id, status: "observed", usage_totals: { input_tokens: 12, output_tokens: 4, cost_usd: null, unknown_cost_tasks: 2, unknown_input_tasks: 0 } });
    const original = (await api("GET", req + "/approvals")).body.approvals[0]; await restart();
    expect((await resources())[0].run_id).toBe(run_id); expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(2);
    const session = await server!.sessions.open("REQ-USAGE"); const read = session.events.readOrdered.bind(session.events);
    const altered = vi.spyOn(session.events, "readOrdered").mockImplementation(async () => (await read()).map(event => event.type === "goal.attempt.completed" && event.payload["status"] === "ready"
      ? { ...event, payload: { ...event.payload, usage_totals: { ...(event.payload["usage_totals"] as object), input_tokens: 0 } } } : event));
    try { expect((await api("POST", req + "/approvals/" + original.approval_id + "/decide", { choice: original.options[0] })).status).toBe(409); }
    finally { altered.mockRestore(); }
    expect((await api("POST", req + "/approvals/" + original.approval_id + "/decide", { choice: original.options[0] })).status).toBe(200);
    await waitFor(async () => (await server!.runs.getRun(run_id)).status === "completed");
  });
  it.each([
    { protocol: "headless" as const, budget: { max_input_tokens: 10 }, mode: "full", status: "exceeded", calls: 2 },
    { protocol: "acp" as const, budget: { max_cost_usd: 1 }, mode: "tokens", status: "unknown", calls: 1 },
    { protocol: "headless" as const, budget: { max_cost_usd: 0.03 }, mode: "full", status: "exceeded", calls: 2 },
    { protocol: "headless" as const, budget: { max_output_tokens: 10 }, mode: "none", status: "unknown", calls: 1 },
  ])("$protocol $status 自动升级并投影受限指标，不在重启后扩额度", async scenario => {
    await prepare(scenario.protocol, scenario.budget, scenario.mode); const run_id = await start();
    await waitFor(async () => (await api("GET", req + "/coordination")).body.rounds[0]?.status === "ok" && !server!.runs.isActive("REQ-USAGE"));
    const view = (await resources())[0]; expect(view).toMatchObject({ run_id, status: scenario.status, usage_budget: scenario.budget });
    const round = (await api("GET", req + "/coordination")).body.rounds[0]; expect(round.goal_usage[0]).toEqual(view);
    const prompt = await readFile(join(root, ".goal-supervisor-prompts.jsonl"), "utf8"); expect(prompt).toContain("usage_totals");
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(scenario.calls);
    await restart(); expect((await resources())[0]).toEqual(view);
    expect(Number(await readFile(join(root, ".goal-worker-calls"), "utf8"))).toBe(scenario.calls);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
  it("伪造 Goal 汇总不会直接展示，server 从当前任务重算并标 invalid", async () => {
    await prepare("headless", { max_input_tokens: 5 }); await start();
    await waitFor(async () => (await api("GET", req + "/coordination")).body.rounds[0]?.status === "ok");
    const session = await server!.sessions.open("REQ-USAGE"); const read = session.events.readOrderedStrict!.bind(session.events);
    const changed = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => (await read()).map(event => event.type === "goal.attempt.completed"
      ? { ...event, payload: { ...event.payload, usage_totals: { ...(event.payload["usage_totals"] as object), input_tokens: 0 } } } : event));
    try { expect((await resources())[0]).toMatchObject({ status: "invalid", usage_totals: { input_tokens: 6 } }); }
    finally { changed.mockRestore(); }
  });
  it("新 run 单独累计，历史 round 的资源区明确绑定当前 run；无预算 API 返回空", async () => {
    await prepare("headless", { max_input_tokens: 5 }); const old = await start();
    await waitFor(async () => (await api("GET", req + "/coordination")).body.rounds[0]?.status === "ok" && !server!.runs.isActive("REQ-USAGE"));
    const first = (await api("GET", req + "/coordination")).body.rounds[0]; const current = await start(); expect(current).not.toBe(old);
    await waitFor(async () => !server!.runs.isActive("REQ-USAGE"));
    expect((await resources())[0]).toMatchObject({ run_id: current, usage_totals: { input_tokens: 6, observed_tasks: 1 } });
    const history = (await api("GET", req + "/coordination/" + first.round_id)).body.round;
    expect(history.goal_usage[0].run_id).toBe(current);
    await server!.app.listen({ port: 0, host: "127.0.0.1" }); const address = server!.app.server.address();
    if (address === null || typeof address === "string") throw Error("没有 HTTP 端口"); const client = createClient("http://127.0.0.1:" + address.port);
    expect((await client.getGoalUsage("REQ-USAGE")).goals[0]?.run_id).toBe(current);
    await client.createRequirement({ req_id: "REQ-NO-BUDGET", title: "无预算" }); expect((await client.getGoalUsage("REQ-NO-BUDGET")).goals).toEqual([]);
  });
});
