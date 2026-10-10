import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient } from "../../console/src/api.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const ids = { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" };
const launch = { provider: "anthropic", model: "large", effort: "high", mode: "code", option_ids: ids, config_options: { extended: true } };
let root: string; let server: BuiltServer; let base: string;
async function configure(effort = "low") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "acp", bin: process.execPath,
    args: [fixture, "--acp", "--launch-config", "--provider-config", "--profile-worker", "--profile-supervisor"], launch,
    readonly_launch: { provider: "openai", model: "small", effort, mode: "plan", option_ids: ids } } } }));
  if (server) await server.agents.reload();
}
const definition = (max_attempts = 1) => stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "same-agent-goal" }, spec: { nodes: [
  { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], max_attempts, no_progress_limit: 2, timeout_ms: 30000,
    review_changes: true, supervisor_agent: "worker", supervisor_timeout_ms: 5000,
    checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } },
    gates: [{ id: "final-human", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "verification-passed", with: { verification_id: "business-value" } }], pass: { human_confirm: true }, on_fail: "block" }] },
] } });
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 12000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("同ACP自动Goal升级等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const facts = () => server.sessions.readEvents("REQ-SUPERVISION");
const calls = async () => (await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const rounds = async () => (await api("GET", "/requirements/REQ-SUPERVISION/coordination")).body.rounds;
async function start(version = 1) { const result = await api("POST", "/requirements/REQ-SUPERVISION/runs", { sdlc_id: "same-agent-goal", sdlc_version: version }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function blocked() { const run_id = await start(); await wait(async () => !server.runs.isActive("REQ-SUPERVISION") && (await rounds())[0]?.status === "ok"); return { run_id, round: (await rounds())[0] }; }
async function restart() { await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 }); }
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-acp-supervision-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await configure(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  expect((await api("POST", "/sdlcs/same-agent-goal/versions/publish", { yaml: definition() })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-SUPERVISION", title: "同ACP自动解释卡点", prd: "# PRD\nLATEST_SUPERVISOR_A：修复业务值并交付自测与人审指南" })).status).toBe(201);
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("同ACP别名自动Goal监督", () => {
  it("code失败后plan自动ask，冷恢复不重发；答复不增加预算，独立授权后code通过并等待人审", async () => {
    const { run_id, round } = await blocked();
    expect(round).toMatchObject({ trigger: "goal_blocked", run_id, agent: "worker", current: true, answerable: true, adoptable: false });
    expect(round.proposal.next_action.evidence).toContainEqual({ source: "goal", id: round.goal_event_id });
    expect((await calls()).map(call => call.configuration.workflow)).toEqual(["code", "plan"]);
    expect((await calls())[1].configuration).toMatchObject({ provider: "openai", llm: "small", thinking: "low", extended: false });
    expect((await facts()).find(event => event.type === "coordinator.round.requested")!.actor).toEqual({ kind: "system", id: "goal-supervisor" });
    expect((await facts()).filter(event => event.type === "goal.retry.authorized")).toHaveLength(0);
    expect(await server.sessions.listApprovals("REQ-SUPERVISION")).toHaveLength(0);
    await restart(); expect(await calls()).toHaveLength(2); expect((await rounds())[0].round_id).toBe(round.round_id);
    const client = createClient(base); const recorded = await client.answerCoordination("REQ-SUPERVISION", round.round_id, { choice: "修复并重新验收" });
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toHaveLength(2);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
    const state = await client.getCoordination("REQ-SUPERVISION", round.round_id); expect(state.round.goal_retry!.available).toBe(true);
    const input = { answer_event_id: recorded.round.answer!.event_id, input_hash: state.round.goal_retry!.input_hash! }; const key = ulid();
    const authorized = await client.retryGoal("REQ-SUPERVISION", round.round_id, input, key);
    expect(await client.retryGoal("REQ-SUPERVISION", round.round_id, input, key)).toEqual(authorized);
    await wait(async () => (await server.sessions.listApprovals("REQ-SUPERVISION")).length === 1);
    expect((await server.runs.getRun(authorized.run.run_id)).status).toBe("waiting_human"); expect((await server.runs.getRun(run_id)).status).toBe("failed");
    expect((await calls()).map(call => call.configuration.workflow)).toEqual(["code", "plan", "code"]);
    const history = await facts(); const auth = history.find(event => event.type === "goal.retry.authorized")!;
    expect(auth.actor.kind).toBe("human"); expect(auth.payload).toMatchObject({ max_attempts: 1, timeout_ms: 30000, failed_run_id: run_id });
    expect(history.filter(event => event.type === "goal.retry.authorized")).toHaveLength(1);
    expect(history.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    expect((await api("GET", "/requirements/REQ-SUPERVISION/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    await restart(); expect(await calls()).toHaveLength(3); expect((await server.runs.getRun(authorized.run.run_id)).status).toBe("waiting_human");
  });

  it("最新PRD和只读配置使旧重试token失效；同blocker只重试plan，不启动worker或增加Goal预算", async () => {
    const { round } = await blocked();
    expect((await api("PUT", "/requirements/REQ-SUPERVISION/docs/prd", { content: "# PRD\nLATEST_SUPERVISOR_B：当前卡点需要最新事实" })).status).toBe(200);
    const before = await server.coordination.get("REQ-SUPERVISION", round.round_id); expect(before.current).toBe(false); expect(before.coordination_retry!.available).toBe(true);
    await configure("high");
    expect((await api("POST", `/requirements/REQ-SUPERVISION/coordination/${round.round_id}/retry`, { input_hash: before.coordination_retry!.input_hash })).status).toBe(409);
    const latest = await server.coordination.get("REQ-SUPERVISION", round.round_id); expect(latest.coordination_retry!.input_hash).not.toBe(before.coordination_retry!.input_hash);
    const client = createClient(base); const child = await client.retryCoordination("REQ-SUPERVISION", round.round_id, latest.coordination_retry!.input_hash!);
    await wait(async () => (await rounds())[0]?.status === "ok");
    const next = (await rounds())[0]; expect(next).toMatchObject({ retry_of_round_id: round.round_id, goal_event_id: round.goal_event_id, current: true, answerable: true });
    expect((await calls()).map(call => call.configuration.workflow)).toEqual(["code", "plan", "plan"]);
    expect((await calls()).at(-1).configuration.thinking).toBe("high"); expect((await calls()).at(-1).prompt).toContain("LATEST_SUPERVISOR_B");
    expect((await facts()).filter(event => event.type === "goal.attempt.started" || event.type === "workflow.run.started")).toHaveLength(2);
    expect((await facts()).filter(event => event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
    await restart(); expect(await calls()).toHaveLength(3);
    const replay = await createClient(base).retryCoordination("REQ-SUPERVISION", round.round_id, latest.coordination_retry!.input_hash!);
    expect(replay.round.round_id).toBe(child.round.round_id); expect(await calls()).toHaveLength(3);
  });

  it("happy path自动修复后直接等待最终review，没有中途supervisor调用或问题", async () => {
    expect((await api("POST", "/sdlcs/same-agent-goal/versions/publish", { yaml: definition(2) })).status).toBe(201);
    await start(2); await wait(async () => (await server.sessions.listApprovals("REQ-SUPERVISION")).length === 1);
    expect((await calls()).map(call => call.configuration.workflow)).toEqual(["code", "code"]);
    expect(await rounds()).toEqual([]); expect((await facts()).filter(event => event.type === "coordinator.round.answered" || event.type === "goal.retry.authorized" || event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
