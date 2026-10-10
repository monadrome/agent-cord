import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { hashEvent, type EventEnvelope } from "agent-cord";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
let root: string;
let server: BuiltServer;
let sequence = 0;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-goal-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

async function api(method: "GET" | "POST", url: string, payload?: unknown) {
  const response = await server.app.inject({ method, url: "/api/v1" + url,
    ...(method === "POST" ? { headers: { "idempotency-key": `goal-test-${sequence++}` } } : {}), ...(payload === undefined ? {} : { payload }) });
  return { status: response.statusCode, body: response.json() };
}
async function waitFor(test: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await test()) { if (Date.now() >= deadline) throw new Error("Goal server 等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function events() { return (await server.sessions.open("REQ-GOAL")).events.readOrdered(); }
async function calls() { return Number(await readFile(join(root, ".goal-worker-calls"), "utf8")); }

async function prepare(protocol: "headless" | "acp", always_fail = false, acceptance = false, source_changes = false, launch_scenario?: "stable" | "drift") {
  if (source_changes) { await mkdir(join(root, "src")); await writeFile(join(root, "src/deleted.ts"), "export const deleted = true;\n"); }
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: protocol, bin: process.execPath,
    args: [fixture, ...(protocol === "acp" ? ["--acp"] : []), ...(always_fail ? ["--always-fail"] : []), ...(source_changes ? ["--source-changes"] : []), ...(protocol === "headless" ? ["{{prompt}}"] : []),
      ...(launch_scenario === undefined ? [] : ["--launch-config"]), ...(launch_scenario === "drift" ? ["--drift-model"] : [])],
    ...(launch_scenario === undefined ? {} : { launch: { model: "large", effort: "high", mode: "code", option_ids: { model: "llm", effort: "thinking", mode: "workflow" } } }),
  } } }));
  server = await buildApp({ root });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-http" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: source_changes ? ["value.txt", "src"] : ["value.txt"], max_attempts: 4, no_progress_limit: 2,
      ...(acceptance ? { acceptance: [{ id: "business-value", criterion: "value.txt 业务值 fixed", checks: ["value-test"] }] } : {}),
      review_changes: true,
      checks: [{ id: "value-test", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed') {console.error('TRUE_GOAL_FAILURE'); process.exit(1)}"] }] } },
    gates: [{ id: "final-review", attach: { node: "deliver", when: "post" }, role: {}, pass: { human_confirm: true }, on_fail: "block",
      checks: [{ ref: "verification-passed", with: { verification_id: "value-test" } }] }] },
    { id: "done", depends_on: ["deliver"] },
  ] } });
  expect((await api("POST", "/sdlcs/goal-http/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-GOAL", title: "Goal 自主交付" })).status).toBe(201);
  const session = await server.sessions.open("REQ-GOAL");
  await writeFile(join(session.dir, "prd.md"), "# PRD\n将 value.txt 的业务值修复为 fixed，交付代码、自测和 review 指南。\n");
  const started = await api("POST", "/requirements/REQ-GOAL/runs", { sdlc_id: "goal-http" });
  expect(started.status).toBe(202);
  return started.body.run.run_id as string;
}

describe("Goal server 交付闭环", () => {
  it("ACP 模型漂移不自测/重试/交付，冷恢复保留失败；修复配置后重新生成有效 Draft", async () => {
    const run_id = await prepare("acp", false, false, false, "drift");
    await waitFor(async () => !server.runs.isActive("REQ-GOAL"));
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toBe(1);
    const before = await events();
    expect(before.find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false });
    expect(before.filter(event => event.type === "verification.completed" || event.type === "gate.waiting" || event.type === "workflow.node.exited")).toHaveLength(0);
    expect(before.find(event => event.type === "goal.attempt.completed")!.payload).toMatchObject({ status: "blocked", attempt: 1 });
    await expect(readFile(join(root, "cord", "REQ-GOAL", "review.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(1); expect((await server.runs.getRun(run_id)).status).toBe("failed");
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "acp", bin: process.execPath,
      args: [fixture, "--acp", "--launch-config"], launch: { model: "large", effort: "high", mode: "code", option_ids: { model: "llm", effort: "thinking", mode: "workflow" } } } } }));
    await server.agents.reload();
    const repaired = await api("POST", "/requirements/REQ-GOAL/runs", { sdlc_id: "goal-http" }); expect(repaired.status).toBe(202);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    expect(await calls()).toBe(2);
    expect((await api("GET", "/requirements/REQ-GOAL")).body.requirement.status).toBe("waiting_human");
    expect((await server.runs.getRun(repaired.body.run.run_id)).status).toBe("waiting_human");
    expect(await readFile(join(root, "cord", "REQ-GOAL", "review.md"), "utf8")).toContain("宿主验证证据");
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect((await server.runs.getRun(repaired.body.run.run_id)).status).toBe("waiting_human"); expect(await calls()).toBe(2);
  });

  it("冷人审缺失首次源码基线时不消费旧 ready，不重建基线或重复 worker", async () => {
    const run_id = await prepare("headless");
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    const session = await server.sessions.open("REQ-GOAL"); const original = await events();
    await server.app.close(); server.index.close();
    const invalid: EventEnvelope[] = [];
    for (const event of original) invalid.push({ ...event, prev_event_hash: invalid.length === 0 ? null : hashEvent(invalid.at(-1)!),
      payload: event.type === "goal.attempt.started" ? { ...event.payload, source_manifest: undefined } : event.payload });
    await writeFile(join(session.dir, "events.jsonl"), invalid.map(event => JSON.stringify(event)).join("\n") + "\n");
    server = await buildApp({ root });
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toBe(2);
    expect((await api("POST", `/requirements/REQ-GOAL/approvals/${approval.approval_id}/decide`, { choice: approval.options[0] })).status).toBe(409);
    const binding = await server.sdlcs.get("goal-http", 1);
    const observation = await readCoordinationExecutionContext(binding.def, await server.sessions.open("REQ-GOAL"), binding.workflow_revision, server.runs);
    expect(observation.goals[0]).toMatchObject({ status: "invalid", current: false });
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it.each(["headless", "acp"] as const)("%s 宿主源码变更指南可读取，冷恢复保留基线，伪造清单不允许人审", async protocol => {
    const run_id = await prepare(protocol, false, false, true);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const session = await server.sessions.open("REQ-GOAL");
    const facts = await events();
    const baseline = facts.find(event => event.type === "goal.attempt.started")!;
    const ready = facts.find(event => event.type === "goal.attempt.completed" && event.payload["status"] === "ready")!;
    expect(ready.payload["change_evidence"]).toMatchObject({ baseline_event_id: baseline.event_id,
      changes: [{ path: "src/added.ts", status: "added" }, { path: "src/deleted.ts", status: "deleted" }, { path: "value.txt", status: "modified" }] });
    const guide = (await api("GET", "/requirements/REQ-GOAL/artifacts?path=review.md")).body.content as string;
    expect(guide).toContain("## 宿主源码变更"); expect(guide).toContain(baseline.event_id);
    const context = await api("GET", `/requirements/REQ-GOAL/runs/${run_id}/nodes/deliver/verification-context`);
    expect(context.status).toBe(200); expect(JSON.stringify(context.body)).not.toContain("source_manifest");
    const binding = await server.sdlcs.get("goal-http", 1);
    const observe = () => readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs);
    const summary = (await observe()).goals[0]!.change_summary;
    expect(summary).toMatchObject({ baseline_event_id: baseline.event_id, total_changes: 3, added: 1, modified: 1, deleted: 1, omitted_changes: 0 });
    expect(summary!.sample).toEqual([{ path: "src/added.ts", status: "added" }, { path: "src/deleted.ts", status: "deleted" }, { path: "value.txt", status: "modified" }]);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    const read = session.events.readOrdered.bind(session.events);
    const forged = vi.spyOn(session.events, "readOrdered").mockImplementation(async () => (await read()).map(event => event.event_id === ready.event_id
      ? { ...event, payload: { ...event.payload, change_evidence: { ...(event.payload["change_evidence"] as object), changes: [] } } } : event));
    try { expect((await api("POST", `/requirements/REQ-GOAL/approvals/${approval.approval_id}/decide`, { choice: approval.options[0] })).status).toBe(409); }
    finally { forged.mockRestore(); }
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(2);
    expect((await server.sessions.listApprovals("REQ-GOAL"))[0]!.approval_id).toBe(approval.approval_id);
    const after = await events();
    expect((await observe()).goals[0]).toMatchObject({ current: true, change_summary: summary });
    expect(after.find(event => event.type === "goal.attempt.started")!.event_id).toBe(baseline.event_id);
    expect(after.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("最终人工审批拒绝缺失验收映射的 ready，测试通过不能绕过声明条件审计", async () => {
    await prepare("headless", false, true);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    const session = await server.sessions.open("REQ-GOAL"); const real_read = session.events.readOrdered.bind(session.events);
    const read = vi.spyOn(session.events, "readOrdered").mockImplementation(async () => (await real_read()).map(event =>
      event.type === "goal.attempt.completed" && event.payload["status"] === "ready" ? { ...event, payload: { ...event.payload, acceptance_evidence: undefined } } : event));
    try {
      const response = await api("POST", "/requirements/REQ-GOAL/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    } finally { read.mockRestore(); }
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
  it("冷等待缺失验收覆盖时 fail-closed，不重复 worker 或记录人工放行", async () => {
    const run_id = await prepare("headless", false, true);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    const session = await server.sessions.open("REQ-GOAL"); const original = await events();
    await server.app.close(); server.index.close();
    // 保持 envelope 因果链合法，单独验证缺失验收映射的语义拒绝。
    const invalid: EventEnvelope[] = [];
    for (const event of original) {
      const changed = { ...event, prev_event_hash: invalid.at(-1) === undefined ? null : hashEvent(invalid.at(-1)!),
        payload: event.type === "goal.attempt.completed" ? { ...event.payload, acceptance_evidence: undefined } : event.payload };
      invalid.push(changed);
    }
    await writeFile(join(session.dir, "events.jsonl"), invalid.map(event => JSON.stringify(event)).join("\n") + "\n");
    server = await buildApp({ root });
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toBe(2);
    expect((await api("POST", "/requirements/REQ-GOAL/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] })).status).toBe(409);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
  it("声明覆盖完整且当前有效，冷恢复后人工可消费原审批完成流程", async () => {
    const run_id = await prepare("acp", false, true);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    await server.app.close(); server.index.close();
    server = await buildApp({ root });
    expect((await api("POST", "/requirements/REQ-GOAL/approvals/" + approval.approval_id + "/decide", { choice: approval.options[0] })).status).toBe(200);
    await waitFor(async () => !server.runs.isActive("REQ-GOAL"));
    expect((await server.runs.getRun(run_id)).status).toBe("completed"); expect(await calls()).toBe(2);
  });
  it.each(["headless", "acp"] as const)("%s 验收覆盖进入真实指南与协调观察，冷恢复保留证据且不重复 worker", async protocol => {
    const run_id = await prepare(protocol, false, true);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const facts = await events(); const ready = facts.filter(event => event.type === "goal.attempt.completed").at(-1)!;
    const passed = facts.filter(event => event.type === "verification.completed" && event.payload["status"] === "passed").at(-1)!;
    const evidence = [{ acceptance_id: "business-value", verification_event_ids: [passed.event_id] }];
    expect(ready.payload["acceptance_evidence"]).toEqual(evidence);
    const binding = await server.sdlcs.get("goal-http", 1); const session = await server.sessions.open("REQ-GOAL");
    expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).goals[0]).toMatchObject({ current: true, acceptance_evidence: evidence });
    const guide = (await api("GET", "/requirements/REQ-GOAL/artifacts?path=review.md")).body.content;
    expect(guide).toContain("宿主验收覆盖"); expect(guide).toContain("business-value"); expect(guide).toContain(passed.event_id);
    const approval = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(2); expect((await server.sessions.listApprovals("REQ-GOAL"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    const read = () => readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs);
    await writeFile(join(root, "value.txt"), "changed-code"); expect((await read()).goals[0]).toMatchObject({ current: false, acceptance_evidence: evidence });
    await writeFile(join(root, "value.txt"), "fixed");
    const real_read = session.events.readOrderedStrict!.bind(session.events);
    session.events.readOrderedStrict = async () => (await real_read()).map(event => event.event_id === ready.event_id ? { ...event, payload: { ...event.payload, acceptance_evidence: undefined } } : event);
    try { expect((await read()).goals[0]).toMatchObject({ status: "invalid", current: false }); }
    finally { session.events.readOrderedStrict = real_read; }
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
  it("ready 协调观察应验证当前输入，代码/指南变化后不能冒称当前交付", async () => {
    const run_id = await prepare("headless");
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const binding = await server.sdlcs.get("goal-http", 1); const session = await server.sessions.open("REQ-GOAL");
    const read = () => readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs);
    expect((await read()).goals[0]).toMatchObject({ status: "ready", current: true, freshness_reason: "current" });
    const summary = (await read()).goals[0]!.change_summary;
    expect(summary).toBeDefined();
    await writeFile(join(root, "value.txt"), "code-after-ready");
    expect((await read()).goals[0]).toMatchObject({ status: "ready", current: false, freshness_reason: "stale_input" });
    expect((await read()).goals[0]!.change_summary).toEqual(summary);
    await writeFile(join(root, "value.txt"), "fixed");
    expect((await read()).goals[0]).toMatchObject({ current: true });
    const guide = join(session.dir, "review.md"); const original = await readFile(guide, "utf8");
    await writeFile(guide, original + "\n新的人审输入\n");
    expect((await read()).goals[0]).toMatchObject({ current: false, freshness_reason: "stale_input" });
    await writeFile(guide, original); expect((await read()).goals[0]).toMatchObject({ current: true });
    await rm(join(root, "value.txt")); await symlink(guide, join(root, "value.txt"));
    expect((await read()).goals[0]).toMatchObject({ status: "ready", current: null, freshness_reason: "unavailable" });
    expect((await read()).goals[0]!.change_summary).toEqual(summary);
    await rm(join(root, "value.txt")); await writeFile(join(root, "value.txt"), "fixed");
    expect((await read()).goals[0]).toMatchObject({ current: true });
    await server.runs.cancel(run_id);
    expect((await read()).goals[0]).toMatchObject({ status: "ready", current: false, freshness_reason: "run_cancelled" });
    expect((await read()).goals[0]!.change_summary).toBeUndefined();
  });
  it.each(["headless", "acp"] as const)("%s 真实子进程自主修复、当前验证、人审挂起和冷恢复", async protocol => {
    const run_id = await prepare(protocol);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    expect(await calls()).toBe(2);
    const original = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    let facts = await events();
    expect(facts.filter(event => event.type === "verification.completed").map(event => (event.payload as any).status)).toEqual(["failed", "passed"]);
    expect(facts.filter(event => event.type === "goal.attempt.completed").map(event => (event.payload as any).status)).toEqual(["retrying", "ready"]);
    expect(facts.filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect(facts.filter(event => event.type === "workflow.node.exited")).toHaveLength(0);
    expect(await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).toContain("TRUE_GOAL_FAILURE");
    const guide = await readFile(join(root, "cord", "REQ-GOAL", "review.md"), "utf8");
    expect(guide).toContain("宿主验证证据");
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(2);
    expect((await server.sessions.listApprovals("REQ-GOAL"))[0]!.approval_id).toBe(original.approval_id);
    await writeFile(join(root, "value.txt"), "stale-code");
    expect((await api("POST", `/requirements/REQ-GOAL/approvals/${original.approval_id}/decide`, { choice: original.options[0] })).status).toBe(409);
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).some(item => item.approval_id !== original.approval_id));
    expect(await calls()).toBe(3);
    const current = (await server.sessions.listApprovals("REQ-GOAL"))[0]!;
    facts = await events();
    expect(facts.filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    const checked_session = await server.sessions.open("REQ-GOAL");
    await checked_session.rebuildLedger();
    const doctor = await checked_session.doctor();
    expect(doctor.ok, JSON.stringify(doctor.checks)).toBe(true);
    expect(current.approval_id).not.toBe(original.approval_id);
  });

  it("持续失败形成明确 run 错误；重启不重复派发、不制造人工放行", async () => {
    const run_id = await prepare("headless", true);
    await waitFor(async () => (await server.runs.getRun(run_id)).status === "failed" && !server.runs.isActive("REQ-GOAL"));
    expect(await calls()).toBe(2);
    expect((await server.runs.getRun(run_id)).error).toContain("无进展");
    expect((await api("GET", "/requirements/REQ-GOAL")).body.requirement.status).toBe("blocked");
    expect(await server.sessions.listApprovals("REQ-GOAL")).toHaveLength(0);
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(2);
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("当前声明的 review 产物可只读查看，未声明/缺失/链接路径不暴露内容", async () => {
    await prepare("headless");
    await waitFor(async () => (await server.sessions.listApprovals("REQ-GOAL")).length === 1);
    const read_guide = () => api("GET", "/requirements/REQ-GOAL/artifacts?path=review.md");
    expect((await read_guide()).body.content).toContain("宿主验证证据");
    expect((await api("GET", "/requirements/REQ-GOAL")).body.requirement.artifacts).toContainEqual({ path: "review.md", available: true });
    expect((await api("GET", "/requirements/REQ-GOAL/artifacts?path=../value.txt")).status).toBe(404);
    expect((await api("GET", "/requirements/REQ-GOAL/artifacts?path=events.jsonl")).status).toBe(404);
    expect((await api("GET", "/requirements/REQ-GOAL/artifacts")).status).toBe(400);
    const file = join(root, "cord", "REQ-GOAL", "review.md");
    await rm(file);
    expect((await read_guide()).status).toBe(404);
    await symlink(join(root, "value.txt"), file);
    expect((await read_guide()).status).toBe(409);
    expect((await api("GET", "/requirements/REQ-GOAL")).body.requirement.artifacts).toContainEqual({ path: "review.md", available: false });
  });
});
