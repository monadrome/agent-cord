import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const worker_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const coordinator_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-acp-agent.mjs", import.meta.url));
const wait_proposal = { summary: "最新交付等待人审", next_action: { kind: "wait", reason: "最终gate人工未决", evidence: [{ source: "workflow", id: "deliver" }] }, risks: [] };
let root: string; let server: BuiltServer; let base: string;
async function configure(provider = "anthropic") {
  const launch = { provider, model: "large", effort: "high", option_ids: { provider: "provider", model: "llm", effort: "thinking" } };
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "acp", bin: process.execPath, args: [worker_fixture, "--acp", "--launch-config", "--provider-config"],
      launch: { ...launch, mode: "code", option_ids: { ...launch.option_ids, mode: "workflow" } } },
    coordinator: { kind: "acp", bin: process.execPath, args: [coordinator_fixture, "--config", "--provider-option", "--provider-without-category", "--no-tools",
      "--record", join(root, "coordination.jsonl"), "--result-text", JSON.stringify(wait_proposal)],
      launch: { ...launch, provider: "anthropic" } },
  } }));
  if (server) await server.agents.reload();
}
async function listen() { base = await server.app.listen({ host: "127.0.0.1", port: 0 }); }
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("Provider交付验收等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const facts = () => server.sessions.readEvents("REQ-PROVIDER");
const calls = async () => (await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const coordination_calls = async () => (await readFile(join(root, "coordination.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function start() { const result = await api("POST", "/requirements/REQ-PROVIDER/runs", { sdlc_id: "provider-delivery" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-PROVIDER/coordination", { agent: "coordinator", sdlc_id: "provider-delivery" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-PROVIDER/coordination/${result.body.round.round_id}`;
  await wait(async () => (await api("GET", path)).body.round.status === "ok"); return (await api("GET", path)).body.round;
}
async function observe() {
  const binding = await server.sdlcs.get("provider-delivery", 1);
  return readCoordinationExecutionContext(binding.def, await server.sessions.open("REQ-PROVIDER"), binding.workflow_revision, server.runs);
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-provider-delivery-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await configure(); server = await buildApp({ root }); await listen();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "provider-delivery" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } },
      gates: [{ id: "final-human", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "verification-passed", with: { verification_id: "business-value" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/provider-delivery/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-PROVIDER", title: "Provider自主交付", prd: "# PRD\nLATEST_PROVIDER_A：修复value.txt并交付宿主自测与人审指南" })).status).toBe(201);
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("Provider启动与最新快照交付", () => {
  it("实际TCP Goal保持路由并自动修复，冷恢复不重复worker；查询幂等且协调读取最新PRD", async () => {
    const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-PROVIDER")).length === 1);
    const original_approval = (await server.sessions.listApprovals("REQ-PROVIDER"))[0]!;
    expect((await calls()).map(call => call.configuration)).toEqual([
      { provider: "anthropic", llm: "large", thinking: "high", workflow: "code" }, { provider: "anthropic", llm: "large", thinking: "high", workflow: "code" },
    ]);
    expect((await facts()).filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    expect((await observe()).goals[0]).toMatchObject({ status: "ready", current: true });
    const guide = (await api("GET", "/requirements/REQ-PROVIDER/artifacts?path=review.md")).body.content;
    expect(guide).toContain("宿主验证证据"); expect(guide).toContain("宿主源码变更");
    await server.app.close(); server.index.close(); server = await buildApp({ root }); await listen();
    expect(await calls()).toHaveLength(2); expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    expect((await server.sessions.listApprovals("REQ-PROVIDER"))[0]!.approval_id).toBe(original_approval.approval_id);
    const key = ulid(); const inspection = await api("POST", "/agents/coordinator/inspect", {}, key); expect(inspection.status).toBe(200);
    expect(inspection.body.observation.config_options.find((option: { id: string }) => option.id === "provider")).toMatchObject({ category: null, values: ["openai", "anthropic"] });
    expect((await coordination_calls()).some(call => call.event === "prompt")).toBe(false);
    const count = (await coordination_calls()).length; expect((await api("POST", "/agents/coordinator/inspect", {}, key)).body).toEqual(inspection.body);
    expect(await coordination_calls()).toHaveLength(count);
    expect((await api("PUT", "/requirements/REQ-PROVIDER/docs/prd", { content: "# PRD\nLATEST_PROVIDER_B：更新需求，仍保留人工终审" })).status).toBe(200);
    const round = await coordinate(); expect(round).toMatchObject({ current: true, proposal: wait_proposal, agent_context_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const prompt = (await coordination_calls()).find(call => call.event === "prompt").text;
    expect(prompt).toContain("LATEST_PROVIDER_B"); expect(prompt).toContain('"current":false,"freshness_reason":"stale_input"');
    expect((await api("GET", "/requirements/REQ-PROVIDER/artifacts?path=review.md")).body.content).toBe(guide);
    expect(await calls()).toHaveLength(2); expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("只换worker路由使旧提议失效；冷恢复原run重检当前配置并保留预算与人审", async () => {
    const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-PROVIDER")).length === 1);
    const previous_ready = (await facts()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
    const round = await coordinate(); expect(round.current).toBe(true);
    await configure("openai");
    const old = await server.coordination.get("REQ-PROVIDER", round.round_id); expect(old).toMatchObject({ current: false, adoptable: false });
    await server.app.close(); server.index.close(); server = await buildApp({ root }); await listen();
    await wait(async () => (await calls()).length === 3 && (await observe()).goals[0]?.current === true && (await server.runs.getRun(run_id)).status === "waiting_human");
    expect(await calls()).toHaveLength(3); expect((await calls()).at(-1).configuration).toMatchObject({ provider: "openai", llm: "large", thinking: "high" });
    expect((await observe()).goals[0]).toMatchObject({ current: true });
    const history = await facts(); const ready = history.filter(event => event.type === "goal.attempt.completed").at(-1)!;
    expect(ready.payload).toMatchObject({ status: "ready", run_id, attempt: 3, max_attempts: 3 });
    expect(ready.payload["input_hash"]).not.toBe(previous_ready.payload["input_hash"]);
    expect(history.filter(event => event.type === "workflow.run.started")).toHaveLength(1);
    const fresh = await coordinate(); expect(fresh.agent_configuration_hash).toBe(round.agent_configuration_hash);
    expect(fresh.agent_context_hash).not.toBe(round.agent_context_hash); expect(fresh.current).toBe(true);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
