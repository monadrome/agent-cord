import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient, type ApiClient } from "../../console/src/api.js";
import { hashEvent, type EventEnvelope } from "agent-cord";

const headless_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/stdin-prompt-worker.mjs", import.meta.url));
const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const req_id = "REQ-GOAL-GATE";
let root: string; let server: BuiltServer; let client: ApiClient;
beforeEach(async () => { server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-goal-gate-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });
async function boot() { server = await buildApp({ root }); client = createClient(await server.app.listen({ host: "127.0.0.1", port: 0 })); }
async function close() { await server.app.close(); server.index.close(); }
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() >= deadline) throw new Error("Goal门禁TCP等待超时"); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function events() { return (await server.sessions.open(req_id)).events.readOrdered(); }
async function calls(protocol: "headless" | "acp") { return (await readFile(join(root, protocol === "acp" ? ".goal-worker-prompts.jsonl" : ".stdin-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
function configuration(protocol: "headless" | "acp", changed = false) {
  return stringify({ agents: { worker: protocol === "acp" ? {
    kind: "acp", bin: process.execPath, args: [acp_fixture, "--acp", "--launch-config", "--provider-config", "--profile-worker"], context_revision: changed ? 2 : 1,
    launch: { provider: "openai", model: "large", effort: "high", mode: "code", option_ids: { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" } },
    readonly_launch: { provider: "openai", model: "small", effort: "low", mode: "plan", option_ids: { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" } },
  } : {
    kind: "headless", bin: process.execPath, prompt_input: "stdin", context_revision: changed ? 2 : 1,
    args: [headless_fixture, "--operation", "workflow", "--model", "{{model}}", "--effort", "{{effort}}", "--readonly", "{{readonly}}", "-"],
    launch: { model: "writer", effort: "high" }, readonly_launch: { model: "reviewer", effort: "low" },
  } } });
}
async function prepare(protocol: "headless" | "acp") {
  await writeFile(join(root, "cord/agents.yaml"), configuration(protocol)); await boot();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-gate" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", input_scope: { kind: "dependencies" }, goal: {
      inputs: ["value.txt"], max_attempts: 3, review_changes: true,
      acceptance: [{ id: "business-value", criterion: "当前业务值正确", checks: ["unit-test"] }],
      checks: [{ id: "unit-test", bin: process.execPath, args: ["-e", "process.exit(require('node:fs').readFileSync('value.txt','utf8')==='fixed'?0:3)"] }],
    } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text", input_scope: { kind: "dependencies" } },
      gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" }, checks: [
        { ref: "file-nonempty", with: { path: "findings.md" } }, { ref: "goal-ready", with: { node_id: "deliver" } },
      ], pass: { human_confirm: true, require: "all" }, on_fail: "block" }] },
    { id: "done", depends_on: ["review"] },
  ] } });
  await client.publishSdlc("goal-gate", yaml); await client.createRequirement({ req_id, title: "Goal后只读评审" });
  await client.writeDoc(req_id, "prd", "# PRD\n修复value.txt并交付自测代码与人审指南。\n");
  const binding = await server.sdlcs.get("goal-gate", 1);
  await server.runs.readNodeInput(binding.def, binding.def.spec.nodes[0]!, await server.sessions.open(req_id), server.agents.resolver()("worker").configuration_hash!, binding.workflow_revision);
  const run = (await client.startRun(req_id, { sdlc_id: "goal-gate" })).run;
  await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
  await wait_for(async () => (await server.runs.getRun(run.run_id)).status === "waiting_human");
  return { run, approval: (await client.getApprovals(req_id)).approvals[0]! };
}
async function finished(run_id: string) { await wait_for(async () => !server.runs.isActive(req_id)); return (await server.runs.getRun(run_id)).status; }
async function assert_original_goal(run_id: string, goal_count: number) {
  const facts = await events(); expect(facts.filter(event => event.type === "workflow.run.started")).toHaveLength(1);
  expect(facts.filter(event => event.type === "goal.attempt.started")).toHaveLength(goal_count);
  expect(facts.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited" && event.payload["node_id"] !== "deliver")).toHaveLength(0);
  expect((await server.runs.latestRun(req_id))?.run_id).toBe(run_id);
}
async function rewrite_facts(change: (event: EventEnvelope) => EventEnvelope) {
  const original = await events(); await close(); const rewritten: EventEnvelope[] = [];
  for (const event of original) rewritten.push({ ...change(event), prev_event_hash: rewritten.length === 0 ? null : hashEvent(rewritten.at(-1)!) });
  await writeFile(join(root, "cord", req_id, "events.jsonl"), rewritten.map(event => JSON.stringify(event)).join("\n") + "\n");
}

describe("当前上游Goal的最终人审TCP门禁", () => {
  it.each(["headless", "acp"] as const)("%s自主交付→只读评审→最终人审，cold不重复，显式选择后原run完成", async protocol => {
    const { run, approval } = await prepare(protocol); const before = await events(); const count = (await calls(protocol)).length;
    expect(before.filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
    expect((await client.readArtifact(req_id, "review.md")).content).toContain("宿主验收覆盖");
    expect(before.filter(event => event.type === "gate.waiting").at(-1)?.payload["reason"]).toContain("当前代码、自测与指南就绪");
    await close(); await boot(); expect((await calls(protocol)).length).toBe(count);
    expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!);
    expect(await finished(run.run_id)).toBe("completed"); expect((await calls(protocol)).length).toBe(count);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(1);
    expect((await client.doctor()).ok).toBe(true);
  });

  it.each(["headless", "acp"] as const)("%s下游报告更新失效旧审批，上游ready保持有效且不另建run", async protocol => {
    const { run, approval } = await prepare(protocol); const count = (await calls(protocol)).length;
    await close(); await boot(); await client.writeDoc(req_id, "findings", "# NEW_FINDINGS\n当前评审仍等待人工。\n");
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    await wait_for(async () => (await client.getApprovals(req_id)).approvals.some(item => item.approval_id !== approval.approval_id));
    const current_calls = await calls(protocol); expect(current_calls.length).toBe(count + 1);
    expect(protocol === "acp" ? current_calls.at(-1).configuration.workflow : current_calls.at(-1).readonly).toBe(protocol === "acp" ? "plan" : true);
    expect((await events()).filter(event => event.type === "goal.attempt.started")).toHaveLength(protocol === "acp" ? 2 : 1);
    const next = (await client.getApprovals(req_id)).approvals[0]!;
    expect((await events()).filter(event => event.type === "workflow.run.started")).toHaveLength(1);
    await client.decideApproval(req_id, next.approval_id, next.options[0]!); expect(await finished(run.run_id)).toBe("completed");
  });

  it.each(["source", "prd", "guide", "config"] as const)("cold等待前%s漂移：启动自动重检原run，上游不重跑且不能人审", async mode => {
    const { run, approval } = await prepare("headless"); const goal_count = (await events()).filter(event => event.type === "goal.attempt.started").length;
    await close();
    if (mode === "source") await writeFile(join(root, "value.txt"), "changed");
    if (mode === "prd") await writeFile(join(root, "cord", req_id, "prd.md"), "# NEW_PRD\n新的需求事实。\n");
    if (mode === "guide") await writeFile(join(root, "cord", req_id, "review.md"), "# NEW_GUIDE\n已被修改。\n");
    if (mode === "config") await writeFile(join(root, "cord/agents.yaml"), configuration("headless", true));
    await boot(); expect(await finished(run.run_id)).toBe("blocked");
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    await assert_original_goal(run.run_id, goal_count); expect((await client.getApprovals(req_id)).approvals).toHaveLength(0);
  });

  it.each(["headless", "acp"] as const)("%s在cold查询之后代码漂移，旧选择触发原run重检，不能借新预算修复", async protocol => {
    const { run, approval } = await prepare(protocol); const goal_count = (await events()).filter(event => event.type === "goal.attempt.started").length;
    const count = (await calls(protocol)).length; await close(); await boot(); await writeFile(join(root, "value.txt"), "changed");
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect(await finished(run.run_id)).toBe("blocked"); await assert_original_goal(run.run_id, goal_count);
    expect((await calls(protocol)).length).toBe(count);
  });

  it.each(["headless", "acp"] as const)("%s在途热重载保留原配置与当前审批", async protocol => {
    const { run, approval } = await prepare(protocol);
    await writeFile(join(root, "cord/agents.yaml"), configuration(protocol, true)); await client.reloadAgents();
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); expect(await finished(run.run_id)).toBe("completed");
  });

  it.each(["removed", "invalid"])("cold Agent配置%s保留可修复等待，不阻止服务启动或伪造决定", async mode => {
    const { run, approval } = await prepare("headless"); const count = (await calls("headless")).length; await close();
    await writeFile(join(root, "cord/agents.yaml"), mode === "removed" ? stringify({ agents: {} }) : configuration("headless").replace("context_revision: 1", "context_revision: invalid"));
    await boot(); expect((await server.runs.getRun(run.run_id)).status).toBe("waiting_human");
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await calls("headless")).length).toBe(count);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await writeFile(join(root, "cord/agents.yaml"), configuration("headless")); await client.reloadAgents();
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); expect(await finished(run.run_id)).toBe("completed");
    expect((await calls("headless")).length).toBe(count);
  });

  it.each(["actor", "coverage", "command", "baseline", "cross-run"])("cold %s来源不完整，报告存在仍不能放行", async mode => {
    const { run, approval } = await prepare("headless"); const goal_count = (await events()).filter(event => event.type === "goal.attempt.started").length;
    await rewrite_facts(event => {
      if (mode === "actor" && event.type === "goal.attempt.completed") return { ...event, actor: { kind: "agent", id: "fake" } };
      if (mode === "coverage" && event.type === "goal.attempt.completed") return { ...event, payload: { ...event.payload, acceptance_evidence: undefined } };
      if (mode === "command" && event.type === "verification.completed") return { ...event, payload: { ...event.payload, command_hash: "d".repeat(64) } };
      if (mode === "baseline" && event.type === "goal.attempt.started") return { ...event, payload: { ...event.payload, source_manifest: undefined } };
      if (mode === "cross-run" && event.type === "goal.attempt.completed") return { ...event, payload: { ...event.payload, run_id: ulid() } };
      return event;
    });
    await boot(); expect(await finished(run.run_id)).toBe("blocked");
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    await assert_original_goal(run.run_id, goal_count);
  });

  it.each([false, true])("已落盘未消费选择在cold重检changed=%s，过期不能退出review", async changed => {
    const { run, approval } = await prepare("headless"); const session = await server.sessions.open(req_id);
    const waiting = (await events()).find(event => event.event_id === approval.approval_id)!;
    await server.runs.close();
    await session.events.append({ event_id: ulid(), session_id: req_id, type: "human.decision.recorded", schema_version: "1", actor: { kind: "human", id: "fixture" }, correlation_id: "review",
      source: { adapter: "fixture" }, payload: { ...waiting.payload, waiting_event_id: approval.approval_id, chosen: approval.options[0], chosen_index: 0, timeout_ms: null, default_index: 0, fallback: null, raw_input: null } });
    if (changed) await writeFile(join(root, "value.txt"), "changed"); await close(); await boot();
    expect(await finished(run.run_id)).toBe(changed ? "blocked" : "completed");
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(1);
    expect((await events()).some(event => event.type === "workflow.node.exited" && event.payload["node_id"] === "done")).toBe(!changed);
  });

  it("同内容新ready替换旧证据，使审批版本变化但不重跑worker", async () => {
    const { run, approval } = await prepare("headless"); const session = await server.sessions.open(req_id); const count = (await calls("headless")).length;
    const ready = (await events()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
    await session.events.append({ event_id: ulid(), session_id: req_id, type: ready.type, schema_version: "1", actor: ready.actor, correlation_id: ready.correlation_id, source: ready.source, payload: ready.payload });
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    await wait_for(async () => (await client.getApprovals(req_id)).approvals.some(item => item.approval_id !== approval.approval_id));
    expect((await calls("headless")).length).toBe(count); const next = (await client.getApprovals(req_id)).approvals[0]!;
    await client.decideApproval(req_id, next.approval_id, next.options[0]!); expect(await finished(run.run_id)).toBe("completed");
  });

  it("失效事件写入失败保留未决版本，不写决定或启动新run；重试可阻断", async () => {
    const { run, approval } = await prepare("headless"); await close(); await boot();
    const session = await server.sessions.open(req_id); const append = session.events.append.bind(session.events);
    await writeFile(join(root, "value.txt"), "changed");
    const spy = vi.spyOn(session.events, "append").mockImplementation(async event => { if (event.type === "gate.invalidated") throw new Error("WRITE_FAILURE"); return append(event); });
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 500 }); spy.mockRestore();
    expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect(await finished(run.run_id)).toBe("blocked");
  });

  it("人工决定写入失败不消费就绪或审批，修复后原run可决定", async () => {
    const { run, approval } = await prepare("headless"); await close(); await boot();
    const session = await server.sessions.open(req_id); const append = session.events.append.bind(session.events);
    const spy = vi.spyOn(session.events, "append").mockImplementation(async event => { if (event.type === "human.decision.recorded") throw new Error("WRITE_FAILURE"); return append(event); });
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 500 }); spy.mockRestore();
    expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); expect(await finished(run.run_id)).toBe("completed");
  });

  it("宿主指南读取前后源码漂移，不能把两份输入拼成当前ready", async () => {
    const { run, approval } = await prepare("headless"); await close(); await boot();
    const read = server.runs.readNodeInput.bind(server.runs); let changed = false;
    const spy = vi.spyOn(server.runs, "readNodeInput").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1].id === "deliver" && !changed) { changed = true; await writeFile(join(root, "value.txt"), "changed"); }
      return result;
    });
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect(await finished(run.run_id)).toBe("blocked"); spy.mockRestore(); await assert_original_goal(run.run_id, 1);
  });

  it.each([false, true])("只落盘失效后重启changed=%s：原run自动接续未完成重检", async changed => {
    const { run, approval } = await prepare("headless"); const session = await server.sessions.open(req_id); const count = (await calls("headless")).length;
    const waiting = (await events()).find(event => event.event_id === approval.approval_id)!;
    await close(); if (changed) await writeFile(join(root, "value.txt"), "changed");
    await session.events.append({ event_id: ulid(), session_id: req_id, type: "gate.invalidated", schema_version: "1", actor: { kind: "system", id: "fixture" }, correlation_id: "review",
      source: { adapter: "fixture" }, payload: { workflow_id: waiting.payload["workflow_id"], workflow_revision: waiting.payload["workflow_revision"], node_id: "review", gate_id: "human-review", waiting_event_id: approval.approval_id, reason: "输入重检待恢复" } });
    await boot();
    if (changed) expect(await finished(run.run_id)).toBe("blocked");
    else await wait_for(async () => (await client.getApprovals(req_id)).approvals.some(item => item.approval_id !== approval.approval_id));
    expect((await calls("headless")).length).toBe(count); await assert_original_goal(run.run_id, 1);
  });

  it("取消等待后不能使用旧ready或旧审批，不产生额外Goal", async () => {
    const { run, approval } = await prepare("acp"); const count = (await calls("acp")).length;
    await client.cancelRun(run.run_id); expect(await finished(run.run_id)).toBe("cancelled");
    await close(); await boot(); await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await calls("acp")).length).toBe(count); expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
