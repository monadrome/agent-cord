/** 独立协调 API：真实 Fastify + 离线 headless 子进程，验证幂等、固定配置、取消和恢复。 */
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { CoordinationRoundView } from "@agent-cord/server/contracts";
import { canonicalJson, sha256Hex, readSnapshot, EVENT_PAYLOAD_SCHEMAS, type EventType } from "agent-cord";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
const acp_fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-acp-agent.mjs");
const proposal = { summary: "当前需求可推进", next_action: { kind: "advance", node_id: "intake", reason: "先确认需求", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
let root: string;
let server: BuiltServer;

async function config(output = JSON.stringify(proposal), sleep_ms = 0): Promise<void> {
  await mkdir(join(root, "cord"), { recursive: true });
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
    kind: "headless", bin: process.execPath,
    args: [fixture, "--mode", "claude", "--no-tools", "--sleep", String(sleep_ms), "--result-text", output, "{{prompt}}"],
  } } }));
}
async function request(method: "GET" | "POST" | "PUT", url: string, payload?: unknown, key?: string) {
  const response = await server.app.inject({ method, url,
    headers: { ...(key !== undefined ? { "idempotency-key": key } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}
async function wait_for(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待协调测试状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function start(key = "coordinate", extra: Record<string, unknown> = {}) {
  return request("POST", "/api/v1/requirements/REQ-CONTEXT/coordination", { agent: "coordinator", ...extra }, key);
}
async function done(round_id: string): Promise<CoordinationRoundView> {
  let round: CoordinationRoundView | undefined;
  await wait_for(async () => {
    const response = await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round_id}`);
    expect(response.status).toBe(200);
    round = response.body.round;
    return round !== undefined && round.status !== "pending" && round.status !== "running";
  });
  return round!;
}
async function restart(): Promise<void> {
  await server.app.close();
  server.index.close();
  server = await buildApp({ root });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-coordination-api-"));
  await config();
  server = await buildApp({ root });
  expect((await request("POST", "/api/v1/requirements", { req_id: "REQ-CONTEXT", title: "协调原型", prd: "# PRD\nCURRENT_CONTEXT" }, "create")).status).toBe(201);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

async function valid_round(): Promise<CoordinationRoundView> {
  const result = await start(ulid());
  expect(result.status).toBe(202);
  const round = await done(result.body.round.round_id);
  expect(round.status).toBe("ok");
  return round;
}
function adopt(round_id: string, key = ulid()) {
  return request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${round_id}/adopt`, {}, key);
}

async function source_workflow(): Promise<void> {
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "src", "draft.ts"), "export const current = 1;\n");
  await server.sdlcs.publish("source-coordination", YAML.stringify({
    apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "source-coordination" },
    spec: { nodes: [
      { id: "intake", artifact: "prd.md", gates: [{ id: "human-intake", role: {}, attach: { node: "intake", when: "post" },
        checks: [{ ref: "file-nonempty", with: { path: "prd.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block" }] },
      { id: "verify", depends_on: ["intake"], gates: [{ id: "machine-tests", role: {}, attach: { node: "verify", when: "post" },
        checks: [{ ref: "verification-passed", with: { verification_id: "tests", inputs: ["src", "tests"] } }],
        pass: { require: "all", human_confirm: false }, on_fail: "escalate" }] },
    ] },
  }));
}

async function source_round(key = ulid()): Promise<CoordinationRoundView> {
  const response = await start(key, { sdlc_id: "source-coordination", sdlc_version: 1 });
  expect(response.status).toBe(202);
  return done(response.body.round.round_id);
}

describe("协调人工澄清", () => {
  const asking = { ...proposal, next_action: { kind: "ask_human", question: "上线的平台范围？", options: ["ONLY_MOBILE", "DESKTOP_AND_MOBILE"], reason: "需要澄清", evidence: proposal.next_action.evidence } };
  async function question() { await config(JSON.stringify(asking)); await server.agents.reload(); return valid_round(); }
  const answer = (id: string, choice = "ONLY_MOBILE", key = ulid()) => request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${id}/answer`, { choice }, key);
  const revoke_answer = (id: string, answer_event_id: string, key = ulid()) => request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${id}/answer/revoke`, { answer_event_id }, key);

  it("撤回可重放且保留历史，旧轮次不重答，新轮次可修正同题", async () => {
    const round = await question(); const recorded = await answer(round.round_id); const id = recorded.body.round.answer.event_id;
    const revoked = await revoke_answer(round.round_id, id, "revoke-first"); expect(revoked.status).toBe(200);
    expect(revoked.body.round).toMatchObject({ answer: { event_id: id, choice: "ONLY_MOBILE", revoked_at: expect.any(String), revocation_event_id: expect.any(String) }, answer_revocable: false, answerable: false });
    expect((await revoke_answer(round.round_id, id, "revoke-first")).body).toEqual(revoked.body);
    expect((await revoke_answer(round.round_id, id)).status).toBe(200);
    expect((await answer(round.round_id)).status).toBe(409);
    const fresh = await question(); expect((await answer(fresh.round_id, "DESKTOP_AND_MOBILE")).status).toBe(200);
    await restart(); expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ answer: { revoked_at: expect.any(String) }, answer_revocable: false });
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answer_revoked")).toHaveLength(1);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
  });

  it("过期预期 ID 和已被新同题选择替代的历史答复不可撤回", async () => {
    const first = await question(); const first_answer = await answer(first.round_id); const first_id = first_answer.body.round.answer.event_id;
    expect((await revoke_answer(first.round_id, ulid())).status).toBe(409);
    const second = await question(); const second_answer = await answer(second.round_id, "DESKTOP_AND_MOBILE");
    expect((await revoke_answer(first.round_id, first_id)).status).toBe(409);
    expect((await revoke_answer(second.round_id, second_answer.body.round.answer.event_id)).status).toBe(200);
  });

  it("撤回追加失败仍保留有效答复，修复后可重试，不新增 gate 决策", async () => {
    const round = await question(); const recorded = await answer(round.round_id); const id = recorded.body.round.answer.event_id;
    const session = await server.sessions.open("REQ-CONTEXT"); const append = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "coordinator.round.answer_revoked" ? Promise.reject(new Error("revoke store unavailable")) : append(draft));
    expect((await revoke_answer(round.round_id, id)).status).toBe(500);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ answer_revocable: true, answer: { choice: "ONLY_MOBILE" } });
    mock.mockRestore(); expect((await revoke_answer(round.round_id, id)).status).toBe(200);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "human.decision.recorded" || event.type === "gate.resolved")).toBe(false);
  });

  it("撤回并发只写一次，答复与撤回不会共享相同响应槽位", async () => {
    const round = await question(); const recorded = await answer(round.round_id); const id = recorded.body.round.answer.event_id;
    const replies = await Promise.all([revoke_answer(round.round_id, id), revoke_answer(round.round_id, id), answer(round.round_id)]);
    expect(replies.map((item) => item.status).sort()).toEqual([200, 200, 409]);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answer_revoked")).toHaveLength(1);
  });

  it("撤回要求幂等键与准确事件格式，旧问题输入变化仍可撤回当前选择", async () => {
    const round = await question(); const recorded = await answer(round.round_id); const id = recorded.body.round.answer.event_id;
    const path = `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}/answer/revoke`;
    expect((await request("POST", path, { answer_event_id: id })).status).toBe(400);
    expect((await request("POST", path, { answer_event_id: "Z".repeat(26) }, ulid())).status).toBe(400);
    await server.sessions.writeDoc("REQ-CONTEXT", "prd", "# 变更后的需求\n旧选择需撤回");
    expect((await revoke_answer(round.round_id, id)).status).toBe(200);
  });

  it("答复持久化且可重放，重启保留选择；不启动 run 或放行 gate", async () => {
    const round = await question();
    const result = await answer(round.round_id, "ONLY_MOBILE", "answer-first");
    expect(result.status).toBe(200);
    expect(result.body.round).toMatchObject({ answer: { choice: "ONLY_MOBILE" }, answerable: false, current: false });
    expect((await answer(round.round_id, "ONLY_MOBILE", "answer-first")).body).toEqual(result.body);
    expect((await answer(round.round_id)).status).toBe(200);
    expect((await answer(round.round_id, "DESKTOP_AND_MOBILE")).status).toBe(409);
    const before = await server.sessions.readEvents("REQ-CONTEXT");
    expect(before.filter((event) => event.type === "coordinator.round.answered")).toHaveLength(1);
    expect(before.some((event) => ["workflow.run.started", "human.decision.recorded", "gate.resolved", "coordinator.round.adopted"].includes(event.type))).toBe(false);
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ answer: { choice: "ONLY_MOBILE" }, answerable: false });
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answered")).toHaveLength(1);
  });

  it("失效、非法选项和非问题不能记录答复；重新协调后可恢复", async () => {
    const round = await question();
    expect((await answer(round.round_id, "unknown")).status).toBe(400);
    await server.sessions.writeDoc("REQ-CONTEXT", "prd", "# 最新需求\n范围已变化");
    expect((await answer(round.round_id)).status).toBe(409);
    const fresh = await question(); expect((await answer(fresh.round_id)).status).toBe(200);
    await config(); await server.agents.reload(); const advance = await valid_round();
    expect((await answer(advance.round_id)).status).toBe(409);
  });

  it("同选择并发只写一次，不同选择并发不会共享错误答复", async () => {
    const round = await question();
    const replies = await Promise.all([answer(round.round_id), answer(round.round_id), answer(round.round_id, "DESKTOP_AND_MOBILE")]);
    expect(replies.map((item) => item.status).sort()).toEqual([200, 200, 409]);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answered")).toHaveLength(1);
  });

  it("追加失败不显示已答复，修复后新幂等键可以记录", async () => {
    const round = await question(); const session = await server.sessions.open("REQ-CONTEXT");
    const append = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "coordinator.round.answered" ? Promise.reject(new Error("answer store unavailable")) : append(draft));
    expect((await answer(round.round_id)).status).toBe(500);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ answer: null, answerable: true });
    mock.mockRestore(); expect((await answer(round.round_id)).status).toBe(200);
  });

  it("答复在另一模型轮次运行中到达，该轮次 stale，新轮次读取澄清", async () => {
    const source = await question(); const driver = server.agents.resolver()("coordinator"); const prompts: string[] = [];
    vi.spyOn(driver, "run").mockImplementation(async function* (task) {
      prompts.push(task.prompt);
      if (prompts.length === 1) expect((await answer(source.round_id)).status).toBe(200);
      yield { type: "result", data: { text: JSON.stringify({ ...proposal, next_action: { kind: "wait", reason: "等待人工 gate", evidence: proposal.next_action.evidence } }) } };
    });
    const first = await start(ulid()); expect(await done(first.body.round.round_id)).toMatchObject({ status: "stale", proposal: null });
    expect(await valid_round()).toMatchObject({ current: true }); expect(prompts[1]).toContain("ONLY_MOBILE");
  });

  it("答复须带幂等键，归档问题或请求额外字段不能记录", async () => {
    const round = await question(); const path = `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}/answer`;
    expect((await request("POST", path, { choice: "ONLY_MOBILE" })).status).toBe(400);
    expect((await request("POST", path, { choice: "ONLY_MOBILE", gate_id: "human" }, ulid())).status).toBe(400);
    expect((await request("POST", path, { choice: "ONLY_MOBILE" }, "create")).status).toBe(409);
    await server.sdlcs.archive("simple-sdlc", 1); expect((await answer(round.round_id)).status).toBe(409);
  });

  it("损坏答复在恢复时隔离本需求，其他需求仍可协调", async () => {
    const round = await question(); const session = await server.sessions.open("REQ-CONTEXT");
    const completed = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "coordinator.round.completed")!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.answered", schema_version: "1", actor: { kind: "human", id: "fixture" }, correlation_id: round.round_id,
      payload: { round_id: round.round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision, completion_event_id: completed.event_id, input_hash: round.input_hash, choice: "UNKNOWN" }, source: { adapter: "test" } });
    await restart(); expect((await request("GET", "/api/v1/health")).status).toBe(200);
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}`)).status).toBe(409);
    expect((await request("POST", "/api/v1/requirements", { req_id: "REQ-HEALTHY", title: "健康需求", prd: "# PRD\n正常澄清" }, ulid())).status).toBe(201);
    const healthy = await request("POST", "/api/v1/requirements/REQ-HEALTHY/coordination", { agent: "coordinator" }, ulid()); expect(healthy.status).toBe(202);
    await wait_for(async () => (await server.coordination.get("REQ-HEALTHY", healthy.body.round.round_id)).status === "ok");
  });

  it("达到当前问题容量时拒绝新增，不丢弃已记录选择", async () => {
    const session = await server.sessions.open("REQ-CONTEXT"); const binding = await server.sdlcs.get("simple-sdlc", 1);
    for (let index = 0; index < 128; index++) {
      const round_id = ulid(); const completed = await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: round_id,
        payload: { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, driver: "fixture", input_hash: "a".repeat(64), status: "ok", error: null, duration_ms: 1,
          proposal: { ...asking, next_action: { ...asking.next_action, question: `已确认的问题 ${index}` } } }, source: { adapter: "test" } });
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.answered", schema_version: "1", actor: { kind: "human", id: "fixture" }, correlation_id: round_id,
        payload: { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, completion_event_id: completed.event_id, input_hash: "a".repeat(64), choice: "ONLY_MOBILE" }, source: { adapter: "test" } });
    }
    const round = await question(); expect(round.answerable).toBe(false);
    expect((await answer(round.round_id)).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answered")).toHaveLength(128);
  });

  it("原问题 envelope 损坏时不可答复，不能先写入无法验证的人工事实", async () => {
    const round = await question(); const session = await server.sessions.open("REQ-CONTEXT");
    const original = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "coordinator.round.completed")!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: ulid(),
      payload: original.payload, source: { adapter: "test" } });
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ answerable: false });
    expect((await answer(round.round_id)).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answered")).toHaveLength(0);
  });

  it("已有人工 gate 等待时记录澄清，原等待不被当作已决定", async () => {
    const started = await request("POST", "/api/v1/requirements/REQ-CONTEXT/runs", {}, ulid()); expect(started.status).toBe(202);
    await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
    const before = (await server.sessions.listApprovals("REQ-CONTEXT"))[0]!;
    const before_events = await server.sessions.readEvents("REQ-CONTEXT");
    const round = await question(); expect((await answer(round.round_id)).status).toBe(200);
    expect((await server.sessions.listApprovals("REQ-CONTEXT"))[0]?.approval_id).toBe(before.approval_id);
    const transitions = (events: typeof before_events) => events.filter((event) => ["human.decision.recorded", "workflow.node.exited", "gate.resolved"].includes(event.type)).map((event) => event.event_id);
    expect(transitions(await server.sessions.readEvents("REQ-CONTEXT"))).toEqual(transitions(before_events));
  });

  it("读取视图后原问题被替代为非问题，写入前拒绝且不落答复事实", async () => {
    const round = await question(); const session = await server.sessions.open("REQ-CONTEXT");
    const original = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "coordinator.round.completed")!;
    const service = server.coordination as any; const read = service.readEvents.bind(service); let reads = 0;
    vi.spyOn(service, "readEvents").mockImplementation(async (...args: unknown[]) => {
      if (++reads === 2) await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: round.round_id,
        payload: { ...(original.payload as Record<string, unknown>), proposal: { ...proposal, next_action: { kind: "wait", reason: "问题已替代", evidence: proposal.next_action.evidence } } }, source: { adapter: "test" } });
      return read(...args);
    });
    expect((await answer(round.round_id)).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.answered")).toHaveLength(0);
  });
});

describe("独立协调工具边界", () => {
  it.each(["claude", "codex", "acp"])("已报告工具的 %s 协调结果失败、不可采用，重启保留失败，修复后可重新协调", async (protocol) => {
    const pid_file = join(root, "tool-coordinator.pid");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
      kind: protocol === "acp" ? "acp" : "headless", bin: process.execPath,
      args: [protocol === "acp" ? acp_fixture : fixture, ...(protocol === "acp" ? [] : ["--mode", protocol]),
        "--pid-file", pid_file, "--result-text", JSON.stringify(proposal), ...(protocol === "acp" ? [] : ["{{prompt}}"])],
    } } }));
    await server.agents.reload();
    const result = await start("tool-round");
    expect(result.status).toBe(202);
    const round = await done(result.body.round.round_id);
    expect(round).toMatchObject({ status: "failed", failure_stage: "driver", proposal: null, adoptable: false,
      error: "独立协调轮次禁止使用工具，请修正 Agent 配置后重新协调" });
    const pid = Number(await readFile(pid_file, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await adopt(round.round_id)).status).toBe(409);
    const before = await server.sessions.readEvents("REQ-CONTEXT");
    expect(before.some((event) => ["coordinator.round.cancel_requested", "coordinator.round.adopted", "human.decision.recorded", "workflow.node.entered"].includes(event.type))).toBe(false);
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "failed", proposal: null, adoptable: false });
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type.startsWith("coordinator.round."))).toHaveLength(3);
    await config(); await server.agents.reload();
    expect(await valid_round()).toMatchObject({ status: "ok", current: true, adoptable: true });
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect(await server.sessions.readDoc("REQ-CONTEXT", "prd")).toContain("CURRENT_CONTEXT");
  });

  it.each(["headless", "acp"])("工具后的静默 %s 进程立即收束，未等到宿主超时，也不留下子进程", async (protocol) => {
    const pid_file = join(root, "silent-tool.pid");
    const child_pid_file = join(root, "silent-tool-child.pid");
    const record_file = join(root, "silent-acp-messages.jsonl");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
      kind: protocol, bin: process.execPath, args: protocol === "headless"
        ? [fixture, "--mode", "claude", "--sleep", "60000", "--pid-file", pid_file, "--child-pid-file", child_pid_file, "--result-text", JSON.stringify(proposal), "{{prompt}}"]
        : [acp_fixture, "--mode", "hang", "--pid-file", pid_file, "--record", record_file, "--result-text", JSON.stringify(proposal)],
    } } }));
    await server.agents.reload();
    const result = await start("silent-tool", { timeout_ms: 30_000 });
    expect(await done(result.body.round.round_id)).toMatchObject({ status: "failed", failure_stage: "driver", proposal: null });
    const pid = Number(await readFile(pid_file, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    if (protocol === "headless") {
      const child_pid = Number(await readFile(child_pid_file, "utf8"));
      await wait_for(async () => { try { process.kill(child_pid, 0); return false; } catch { return true; } });
    } else {
      expect((await readFile(record_file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).event)).toContain("session/cancel");
    }
  });

  it("旧工具策略的成功提议保留历史，但重启后不可采用，新轮次恢复", async () => {
    const current = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    const binding = await server.sdlcs.get("simple-sdlc", 1);
    const snapshot = await readSnapshot(session, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, excerpt_mode: "head_tail",
      files: binding.def.spec.nodes.flatMap((node) => node.artifact === undefined ? [] : [node.artifact]) });
    const execution_context = await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs);
    const legacy_hash = sha256Hex(canonicalJson({ domain: "cord.coordination-input.v6", context_policy: "balanced-head-tail.v1", workflow: binding.def,
      configuration_hash: current.agent_configuration_hash, max_prompt_chars: 60_000, workflow_revision: binding.workflow_revision, execution_context,
      req_id: snapshot.req_id, title: snapshot.title, docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
      ledger: snapshot.ledger, workflow_progress: { ...snapshot.workflow, waiting: snapshot.workflow.waiting ?? [] } }));
    const round_id = ulid();
    for (const [type, payload] of [
      ["coordinator.round.requested", { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision,
        driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }],
      ["coordinator.round.completed", { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision,
        driver: "headless:coordinator", status: "ok", proposal, error: null, duration_ms: 1, input_hash: legacy_hash,
        agent_configuration_hash: current.agent_configuration_hash }],
    ] as const) await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1",
      actor: { kind: "system", id: "legacy" }, correlation_id: round_id, payload, source: { adapter: "test" } });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round_id)).toMatchObject({ status: "ok", proposal, current: false, adoptable: false });
    expect((await adopt(round_id)).status).toBe(409);
    expect(await valid_round()).toMatchObject({ current: true, adoptable: true });
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
  });
});

describe("协调执行观察", () => {
  it("仅上下文版本声明变化使旧提议不可采用，重新协调恢复，环境值不公开", async () => {
    const configure = async (context_revision: number) => {
      await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: { kind: "headless", context_revision, bin: process.execPath,
        args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(proposal), "{{prompt}}"], env: { PRIVATE_ENV: "PRIVATE_CONTEXT_ENV" } } } }));
      await server.agents.reload();
    };
    await configure(1); const first = await valid_round();
    await configure(2); expect(await server.coordination.get("REQ-CONTEXT", first.round_id)).toMatchObject({ current: false, adoptable: false });
    expect((await adopt(first.round_id)).status).toBe(409);
    const current = await valid_round(); expect(current).toMatchObject({ current: true }); expect(current.agent_configuration_hash).not.toBe(first.agent_configuration_hash);
    expect(JSON.stringify(server.agents.catalog())).not.toContain("PRIVATE_CONTEXT_ENV");
    expect(JSON.stringify(await server.sessions.readEvents("REQ-CONTEXT"))).not.toContain("PRIVATE_CONTEXT_ENV");
  });

  const waiting = { ...proposal, next_action: { kind: "wait", reason: "等待当前 worker 执行结论", evidence: [{ source: "workflow", id: "intake" }] } };
  async function prepare(worker_sleep = 0) {
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: {
      coordinator: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(waiting), "{{prompt}}"] },
      worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", worker_sleep > 0 ? "claude" : "fail", "--sleep", String(worker_sleep), "{{prompt}}"] },
    } }));
    await server.agents.reload();
    await server.sdlcs.publish("task-context", YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "task-context" }, spec: { nodes: [
      { id: "intake", artifact: "plan.md", run: { agent: "worker", readonly: false }, gates: [{ id: "human-plan", role: {}, attach: { node: "intake", when: "post" },
        checks: [{ ref: "file-nonempty", with: { path: "plan.md" } }], pass: { require: "all", human_confirm: true }, on_fail: "block" }] },
    ] } }));
    const result = await request("POST", "/api/v1/requirements/REQ-CONTEXT/runs", { sdlc_id: "task-context", sdlc_version: 1 }, "worker-run");
    expect(result.status).toBe(202);
    return result.body.run.run_id as string;
  }
  const coordinate = async () => {
    const response = await start(ulid(), { sdlc_id: "task-context", sdlc_version: 1 });
    expect(response.status).toBe(202);
    return done(response.body.round.round_id);
  };
  async function failed() {
    const run_id = await prepare();
    await wait_for(async () => (await server.runs.getRun(run_id)).status === "failed" && !server.runs.isActive("REQ-CONTEXT"));
    return run_id;
  }

  it("真实 worker 失败状态进入协调 prompt，任务变化使旧轮次失效且可恢复", async () => {
    const run_id = await failed();
    const worker = server.agents.resolver()("coordinator");
    const original = worker.run.bind(worker);
    const prompts: string[] = [];
    vi.spyOn(worker, "run").mockImplementation(async function* (task) { prompts.push(task.prompt); yield* original(task); });
    const first = await coordinate();
    expect(first).toMatchObject({ status: "ok", current: true });
    expect(first.execution_context_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prompts[0]).toContain('"status":"failed"');
    const session = await server.sessions.open("REQ-CONTEXT");
    const binding = await server.sdlcs.get("task-context", 1);
    const task = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "agent.task.completed")!;
    expect(task.payload["run_id"]).toBe(run_id);
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: "intake",
      payload: { ...(task.payload as Record<string, unknown>), status: "timeout", text: "PRIVATE_TASK_TEXT", error: "PRIVATE_TASK_ERROR" }, source: { adapter: "fixture" } });
    expect(await server.coordination.get("REQ-CONTEXT", first.round_id)).toMatchObject({ current: false, adoptable: false });
    const second = await coordinate();
    expect(second).toMatchObject({ status: "ok", current: true });
    expect(second.execution_context_hash).not.toBe(first.execution_context_hash);
    expect(prompts[1]).toContain('"status":"timeout"');
    expect(prompts[1]).not.toContain("PRIVATE_TASK_");
    expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).run?.active).toBe(false);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });

  it("当前任务可以作为来源，旧任务被替换后不再是合法来源，重启保留观察摘要", async () => {
    await failed();
    const session = await server.sessions.open("REQ-CONTEXT");
    const task = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "agent.task.completed")!;
    await config(JSON.stringify({ ...waiting, next_action: { ...waiting.next_action, evidence: [{ source: "agent_task", id: task.event_id }] } }));
    await server.agents.reload();
    const round = await coordinate();
    expect(round).toMatchObject({ status: "ok", current: true });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: true, execution_context_hash: round.execution_context_hash });
    const restored = await server.sessions.open("REQ-CONTEXT");
    await restored.events.append({ event_id: ulid(), session_id: restored.req_id, type: "agent.task.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: "intake",
      payload: task.payload, source: { adapter: "fixture" } });
    expect(await coordinate()).toMatchObject({ status: "failed", failure_stage: "output", proposal: null });
  });

  it("仅任务观察在途变化导致 stale，新一轮重新采集可恢复", async () => {
    await failed();
    await config(JSON.stringify(waiting), 300); await server.agents.reload();
    const response = await start(ulid(), { sdlc_id: "task-context", sdlc_version: 1 });
    const round_id = response.body.round.round_id;
    await wait_for(async () => (await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "coordinator.round.started" && event.payload["round_id"] === round_id));
    const session = await server.sessions.open("REQ-CONTEXT");
    const task = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "agent.task.completed")!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "agent.task.completed", schema_version: "1", actor: { kind: "agent", id: "fixture" }, correlation_id: "intake",
      payload: task.payload, source: { adapter: "fixture" } });
    expect(await done(round_id)).toMatchObject({ status: "stale", proposal: null });
    expect(await coordinate()).toMatchObject({ status: "ok", current: true });
  });

  it("活动 run 不接受 advance，等待提议可用，停止后新一轮可提议重试", async () => {
    const run_id = await prepare(60_000);
    await wait_for(async () => (await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "agent.task.started"));
    expect(await coordinate()).toMatchObject({ status: "ok", current: true, adoptable: false });
    await config(JSON.stringify(proposal)); await server.agents.reload();
    expect(await coordinate()).toMatchObject({ status: "failed", proposal: null, failure_stage: "output" });
    await server.runs.cancel(run_id);
    expect(await coordinate()).toMatchObject({ status: "ok", current: true, adoptable: true });
  });
});

describe("协调事件完整性", () => {
  it("坏事实流中的明确取消仍收束真实子进程，报告 409，修复后可读取真实取消终态", async () => {
    const pid_file = join(root, "coordinator.pid");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
      kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "--sleep", "60000", "--pid-file", pid_file, "--result-text", JSON.stringify(proposal), "{{prompt}}"],
    } } }));
    await server.agents.reload();
    const response = await start("before-corrupt-cancel");
    expect(response.status).toBe(202);
    let pid = 0;
    await wait_for(async () => { try { pid = Number(await readFile(pid_file, "utf8")); return pid > 0; } catch { return false; } });
    const path = join(root, "cord", "REQ-CONTEXT", "events.jsonl");
    await appendFile(path, "PRIVATE_BROKEN_WAITING\n");
    const url = `/api/v1/requirements/REQ-CONTEXT/coordination/${response.body.round.round_id}/cancel`;
    expect((await request("POST", url, {}, "corrupt-cancel")).status).toBe(409);
    expect(() => process.kill(pid, 0)).toThrow();
    const repaired = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "PRIVATE_BROKEN_WAITING").join("\n");
    await writeFile(path, repaired);
    expect(await server.coordination.get("REQ-CONTEXT", response.body.round.round_id)).toMatchObject({ status: "cancelled", proposal: null });
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((item) => item.type === "coordinator.round.cancel_requested")).toHaveLength(0);
    expect((await request("POST", url, {}, "corrupt-cancel")).status).toBe(200);
    await config(); await server.agents.reload();
    expect(await valid_round()).toMatchObject({ current: true });
  });

  it.each(["broken", "foreign"])("当前事件流 %s 时查询/采用/新建拒绝，修复后不缓存旧错误", async (kind) => {
    const round = await valid_round();
    const path = join(root, "cord", "REQ-CONTEXT", "events.jsonl");
    const baseline = await readFile(path, "utf8");
    const stream = await server.sessions.readEvents("REQ-CONTEXT");
    const corrupt = kind === "broken" ? "PRIVATE_BROKEN_WAITING\n" : JSON.stringify({ ...stream[0], event_id: ulid(), session_id: "REQ-FOREIGN" }) + "\n";
    await appendFile(path, corrupt);
    for (const response of [await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}`),
      await adopt(round.round_id), await start("corrupt-new")]) {
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain("PRIVATE_BROKEN_WAITING");
    }
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((item) => item.type === "coordinator.round.requested")).toHaveLength(1);
    await writeFile(path, baseline);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: true, adoptable: true });
    const retry = await start("corrupt-new");
    expect(retry.status).toBe(202);
    expect(await done(retry.body.round.round_id)).toMatchObject({ current: true });
  });

  it("冷恢复隔离损坏需求，服务保持健康且不执行旧调用，修复重启后可重新协调", async () => {
    const round = await valid_round();
    const path = join(root, "cord", "REQ-CONTEXT", "events.jsonl");
    await server.app.close(); server.index.close();
    const baseline = await readFile(path, "utf8");
    await appendFile(path, "PRIVATE_BROKEN_WAITING\n");
    server = await buildApp({ root });
    expect((await request("GET", "/api/v1/health")).body.ok).toBe(true);
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}`)).status).toBe(409);
    await server.app.close(); server.index.close();
    await writeFile(path, baseline);
    server = await buildApp({ root });
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "ok", current: true });
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(1);
    expect(await valid_round()).toMatchObject({ current: true });
  });

  it("坏的未完成轮次保留原事实，其他需求可协调，修复重启才记 interrupted", async () => {
    const binding = await server.sdlcs.get("simple-sdlc", 1);
    const session = await server.sessions.open("REQ-CONTEXT");
    const round_id = ulid();
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.requested", schema_version: "1",
      actor: { kind: "human", id: "test" }, correlation_id: round_id, payload: { round_id, workflow_id: binding.def.metadata.id,
        workflow_revision: binding.workflow_revision, driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }, source: { adapter: "test" } });
    await server.app.close(); server.index.close();
    const path = join(session.dir, "events.jsonl");
    const baseline = await readFile(path, "utf8");
    await appendFile(path, "PRIVATE_BROKEN_WAITING\n");
    server = await buildApp({ root });
    expect(await readFile(path, "utf8")).toBe(baseline + "PRIVATE_BROKEN_WAITING\n");
    expect((await request("POST", "/api/v1/requirements", { req_id: "REQ-HEALTHY", title: "健康需求", prd: "# PRD\n正常协调" }, "healthy-create")).status).toBe(201);
    const started = await request("POST", "/api/v1/requirements/REQ-HEALTHY/coordination", { agent: "coordinator" }, "healthy-coordinate");
    expect(started.status).toBe(202);
    await wait_for(async () => (await server.coordination.get("REQ-HEALTHY", started.body.round.round_id)).status === "ok");
    expect(await readFile(path, "utf8")).toBe(baseline + "PRIVATE_BROKEN_WAITING\n");
    await server.app.close(); server.index.close();
    await writeFile(path, baseline);
    server = await buildApp({ root });
    expect(await server.coordination.get("REQ-CONTEXT", round_id)).toMatchObject({ status: "failed", failure_stage: "interrupted", proposal: null });
    const recovered = await server.sessions.readEvents("REQ-CONTEXT");
    expect(recovered.filter((item) => item.type === "coordinator.round.started")).toHaveLength(0);
    expect(recovered.filter((item) => item.type === "coordinator.round.completed")).toHaveLength(1);
    expect(await valid_round()).toMatchObject({ current: true });
  });
});

describe("协调提议源码身份", () => {
  it("源码声明缺失时协调失败，输入修复后新轮次可恢复", async () => {
    await source_workflow();
    await rm(join(root, "src"), { recursive: true });
    const failed = await source_round();
    expect(failed).toMatchObject({ status: "failed", proposal: null, failure_stage: "snapshot", source_hash: null });
    const completion = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "coordinator.round.completed");
    expect(completion?.payload).not.toHaveProperty("agent_session_id");
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "draft.ts"), "export const current = 1;\n");
    expect(await source_round()).toMatchObject({ status: "ok", current: true });
  });

  it("中断轮次重启保留源码摘要，不重放付费调用", async () => {
    await source_workflow();
    const binding = await server.sdlcs.get("source-coordination", 1);
    const round_id = ulid();
    const source_hash = "d".repeat(64);
    const session = await server.sessions.open("REQ-CONTEXT");
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.requested", schema_version: "1",
      actor: { kind: "human", id: "test" }, correlation_id: round_id,
      payload: { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, driver: "coordinator", sdlc_id: "source-coordination", sdlc_version: 1 }, source: { adapter: "test" } });
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.started", schema_version: "1",
      actor: { kind: "agent", id: "test" }, correlation_id: round_id,
      payload: { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, driver: "headless:coordinator", source_hash, input_hash: "a".repeat(64) }, source: { adapter: "test" } });
    await restart();
    expect(await server.coordination.get(session.req_id, round_id)).toMatchObject({ status: "failed", proposal: null, failure_stage: "interrupted", source_hash });
    const events = await server.sessions.readEvents(session.req_id);
    expect(events.filter((event) => event.type === "coordinator.round.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "coordinator.round.completed")?.payload).toMatchObject({ source_hash });
    expect(events.filter((event) => event.type === "coordinator.round.started")).toHaveLength(1);
  });

  it.each(["edit", "add", "delete"])("声明的后续节点源码发生 %s 后，旧提议不可采用且不登记 run", async (change) => {
    await source_workflow();
    const first = await source_round();
    expect(first).toMatchObject({ status: "ok", current: true, adoptable: true });
    const file = join(root, "src", "draft.ts");
    if (change === "edit") await writeFile(file, "export const current = 2;\n");
    if (change === "add") await writeFile(join(root, "src", "new.ts"), "export const added = true;\n");
    if (change === "delete") await rm(file);
    expect(await server.coordination.get("REQ-CONTEXT", first.round_id)).toMatchObject({ status: "ok", current: false, adoptable: false });
    expect((await adopt(first.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    if (change === "add") await rm(join(root, "src", "new.ts"));
    else await writeFile(file, "export const current = 1;\n");
    expect((await server.coordination.get("REQ-CONTEXT", first.round_id)).adoptable).toBe(true);
    expect(first.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("源码在模型执行期间变更导致 stale，新轮次恢复并保留源码 provenance", async () => {
    await source_workflow();
    await config(JSON.stringify(proposal), 250);
    await server.agents.reload();
    const response = await start("source-in-flight", { sdlc_id: "source-coordination", sdlc_version: 1 });
    await wait_for(async () => (await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "coordinator.round.started"));
    await writeFile(join(root, "src", "draft.ts"), "export const current = 2;\n");
    const first = await done(response.body.round.round_id);
    expect(first).toMatchObject({ status: "stale", proposal: null, failure_stage: "freshness" });
    const second = await source_round();
    expect(second).toMatchObject({ status: "ok", current: true, adoptable: true });
    expect(second.source_hash).not.toBe(first.source_hash);
    expect(second.input_hash).not.toBe(first.input_hash);
    const events = await server.sessions.readEvents("REQ-CONTEXT");
    expect(events.filter((event) => event.type.startsWith("workflow.") || event.type.startsWith("agent.task."))).toHaveLength(0);
  });

  it("采用进入运行槽位前源码变化，guard 重检拒绝派发", async () => {
    await source_workflow();
    const round = await source_round();
    const start_run = server.runs.start.bind(server.runs);
    vi.spyOn(server.runs, "start").mockImplementation(async (...args) => {
      await writeFile(join(root, "src", "draft.ts"), "export const current = 2;\n");
      return start_run(...args);
    });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
  });

  it("源码出现链接时无法判定，查询/采用 fail-closed，修复后恢复", async () => {
    await source_workflow();
    const round = await source_round();
    const file = join(root, "src", "draft.ts");
    await writeFile(join(root, "private.ts"), "PRIVATE_SOURCE_BODY");
    await rm(file);
    await symlink(join(root, "private.ts"), file);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: null, adoptable: false });
    const rejected = await adopt(round.round_id);
    expect(rejected.status).toBe(409);
    expect(JSON.stringify(rejected.body)).not.toContain("PRIVATE_SOURCE_BODY");
    await rm(file);
    await writeFile(file, "export const current = 1;\n");
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: true, adoptable: true, source_hash: round.source_hash });
  });
});

describe("协调机器验证上下文", () => {
  const waiting = { summary: "机器结果需独立核验", next_action: { kind: "wait", reason: "等待当前验证", evidence: [{ source: "workflow", id: "verify" }] }, risks: [] };
  async function prepare() {
    await source_workflow();
    await config(JSON.stringify(waiting));
    await server.agents.reload();
    const run = await server.runs.start("REQ-CONTEXT", "source-coordination", 1);
    await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
    return run;
  }
  async function verify(run_id: string, status = "failed") {
    const context = await request("GET", `/api/v1/requirements/REQ-CONTEXT/runs/${run_id}/nodes/verify/verification-context`);
    expect(context.status).toBe(200);
    const result = await request("POST", `/api/v1/requirements/REQ-CONTEXT/runs/${run_id}/verifications`, {
      run_id, node_id: "verify", verification_id: "tests", input_hash: context.body.verification.input_hash,
      command_hash: "f".repeat(64), status, exit_code: status === "passed" ? 0 : 1, summary: "PRIVATE_TEST_LOG",
    }, ulid());
    expect(result.status).toBe(200);
    return result.body.event_id as string;
  }

  it("缺失/失败/通过观察进入真实 driver prompt，状态改变使旧提议过期", async () => {
    const run = await prepare();
    const driver = server.agents.resolver()("coordinator");
    const original = driver.run.bind(driver);
    const prompts: string[] = [];
    vi.spyOn(driver, "run").mockImplementation(async function* (task) { prompts.push(task.prompt); yield* original(task); });
    const missing = await source_round();
    expect(prompts[0]).toContain('"status":"missing"');
    await verify(run.run_id);
    expect(await server.coordination.get("REQ-CONTEXT", missing.round_id)).toMatchObject({ status: "ok", current: false });
    const failed = await source_round();
    expect(prompts[1]).toContain('"status":"failed","current":true');
    expect(prompts[1]).not.toContain("PRIVATE_TEST_LOG");
    await verify(run.run_id, "passed");
    expect(await server.coordination.get("REQ-CONTEXT", failed.round_id)).toMatchObject({ status: "ok", current: false });
    const passed = await source_round();
    expect(prompts[2]).toContain('"status":"passed","current":true');
    expect(passed.verification_context_hash).not.toBe(failed.verification_context_hash);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await server.sessions.listApprovals("REQ-CONTEXT"))[0]?.node_id).toBe("intake");
  });

  it("当前失败事件可作为严格提议来源，过期事件不再有效", async () => {
    const run = await prepare();
    const event_id = await verify(run.run_id);
    await config(JSON.stringify({ ...waiting, next_action: { ...waiting.next_action, evidence: [{ source: "verification", id: event_id }] } }));
    await server.agents.reload();
    expect(await source_round()).toMatchObject({ status: "ok", current: true });
    await verify(run.run_id, "passed");
    expect(await source_round()).toMatchObject({ status: "failed", proposal: null, failure_stage: "output" });
  });

  it("模型运行期间仅机器验证变化也使提议 stale", async () => {
    const run = await prepare();
    await verify(run.run_id);
    await config(JSON.stringify(waiting), 300);
    await server.agents.reload();
    const response = await start(ulid(), { sdlc_id: "source-coordination", sdlc_version: 1 });
    const id = response.body.round.round_id;
    await wait_for(async () => (await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "coordinator.round.started" && (event.payload as any).round_id === id));
    await verify(run.run_id, "passed");
    expect(await done(id)).toMatchObject({ status: "stale", proposal: null, failure_stage: "freshness" });
    expect(await source_round()).toMatchObject({ status: "ok", current: true });
  });

  it("采用 guard 在状态不变时也拒绝已更换的验证事件", async () => {
    await source_workflow();
    const binding = await server.sdlcs.get("source-coordination", 1);
    const session = await server.sessions.open("REQ-CONTEXT");
    const run_id = ulid();
    server.index.insertRun({ run_id, req_id: session.req_id, sdlc_id: binding.sdlc_id, sdlc_version: 1, workflow_revision: binding.workflow_revision,
      started_at: new Date().toISOString(), status: "running", finished_at: null, error: null });
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.started", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: run_id,
      payload: { run_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, sdlc_id: binding.sdlc_id, sdlc_version: 1 }, source: { adapter: "test" } });
    const input = await server.runs.readNodeInput(binding.def, binding.def.spec.nodes[1]!, session, null, binding.workflow_revision);
    const result = { run_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, node_id: "verify", verification_id: "tests", input_hash: input.input_hash, command_hash: "f".repeat(64), status: "passed", exit_code: 0 };
    await server.sessions.recordVerification(session.req_id, result);
    const round = await source_round();
    expect(round.adoptable).toBe(true);
    const launch = server.runs.start.bind(server.runs);
    vi.spyOn(server.runs, "start").mockImplementation(async (...args) => {
      await server.sessions.recordVerification(session.req_id, result);
      return launch(...args);
    });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns(session.req_id)).toHaveLength(1);
    expect((await server.sessions.readEvents(session.req_id)).filter((event) => event.type === "coordinator.round.adopted")).toHaveLength(0);
  });
});

describe("协调提议受控采用", () => {
  it("采用当前 advance 提议启动绑定 SDLC，事实在节点派发前落盘，人工 gate 仍挂起", async () => {
    const round = await valid_round();
    expect(round).toMatchObject({ agent: "coordinator", current: true, adoptable: true, adopted_run_id: null });
    expect((await request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}/adopt`, {})).status).toBe(400);
    const response = await adopt(round.round_id);
    expect(response.status).toBe(202);
    const run_id = response.body.run.run_id;
    expect(server.index.getRun(run_id)?.coordination_round_id).toBe(round.round_id);
    expect(response.body.run).toMatchObject({ sdlc_id: "simple-sdlc", sdlc_version: 1 });
    await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
    const after = await server.coordination.get("REQ-CONTEXT", round.round_id);
    expect(after).toMatchObject({ status: "ok", adoptable: false, adopted_run_id: run_id });
    const events = await server.sessions.readEvents("REQ-CONTEXT");
    const adoption = events.find((event) => event.type === "coordinator.round.adopted")!;
    expect(adoption.actor.kind).toBe("human");
    expect(adoption.payload).toMatchObject({ round_id: round.round_id, workflow_id: round.workflow_id, node_id: "intake", input_hash: round.input_hash, run_id });
    expect(EVENT_PAYLOAD_SCHEMAS["coordinator.round.adopted"]?.safeParse(adoption.payload).success).toBe(true);
    expect(adoption.seq).toBeLessThan(events.find((event) => event.type === "workflow.node.entered")!.seq);
    expect(events.filter((event) => event.type === "gate.resolved").some((event) => (event.payload as Record<string, unknown>).human_confirmed === true)).toBe(false);
  });

  it("历史 ok 在文档变化后 current=false，采用 409 且不登记 run；恢复原输入可以重新核验", async () => {
    const round = await valid_round();
    const file = join(root, "cord", "REQ-CONTEXT", "prd.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, "# PRD\nCHANGED_AFTER_COMPLETION");
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "ok", current: false, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    await writeFile(file, original);
    expect((await server.coordination.get("REQ-CONTEXT", round.round_id)).adoptable).toBe(true);
  });

  it("同别名配置变化后旧提议不可采用，使用 requested 的原别名核验配置", async () => {
    const round = await valid_round();
    expect(round.agent).toBe("coordinator");
    expect(round.driver).toBe("headless:coordinator");
    await config(JSON.stringify({ ...proposal, summary: "CHANGED_CONFIGURATION" }));
    await server.agents.reload();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ status: "ok", current: false, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    const fresh = await valid_round();
    expect((await adopt(fresh.round_id)).status).toBe(202);
  });

  it("同轮并发采用只启动一个 run，取消和重启后重复采用仍返回原 run", async () => {
    const round = await valid_round();
    const results = await Promise.all([adopt(round.round_id), adopt(round.round_id), adopt(round.round_id)]);
    expect(results.map((item) => item.status)).toEqual([202, 202, 202]);
    expect(new Set(results.map((item) => item.body.run.run_id)).size).toBe(1);
    const run_id = results[0]!.body.run.run_id;
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
    await server.runs.cancel(run_id);
    await writeFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "# AFTER_ADOPTION_CHANGE");
    await restart();
    const replay = await adopt(round.round_id);
    expect(replay.status).toBe(202);
    expect(replay.body.run).toMatchObject({ run_id, status: "cancelled" });
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => event.type === "coordinator.round.adopted")).toHaveLength(1);
  });

  it("普通 run 与采用并发只允许一个进入运行槽位", async () => {
    const round = await valid_round();
    const results = await Promise.all([adopt(round.round_id), request("POST", "/api/v1/requirements/REQ-CONTEXT/runs", {}, "ordinary-run")]);
    expect(results.map((item) => item.status).sort()).toEqual([202, 409]);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(1);
  });

  it("进入 run 槽位后再次核验：查询有效但文件在启动前变化仍 409", async () => {
    const round = await valid_round();
    const real_start = server.runs.start.bind(server.runs);
    vi.spyOn(server.runs, "start").mockImplementation(async (...args) => {
      await writeFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "# CHANGED_BEFORE_RESERVED_VALIDATION");
      return real_start(...args);
    });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "coordinator.round.adopted")).toBe(false);
  });

  it("采用事件追加失败不派发节点，登记 failed 并释放槽位，修复后重新协调再采用", async () => {
    const round = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    const real_append = session.events.append.bind(session.events);
    const mock = vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "coordinator.round.adopted" ? Promise.reject(new Error("adoption store unavailable")) : real_append(draft));
    expect((await adopt(round.round_id)).status).toBe(500);
    expect(server.runs.listRuns("REQ-CONTEXT")[0]?.status).toBe("failed");
    expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "workflow.node.entered" || event.type === "coordinator.round.adopted")).toBe(false);
    mock.mockRestore();
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: false, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    const refreshed = await valid_round();
    expect((await adopt(refreshed.round_id)).status).toBe(202);
  });

  it("归档版本阻止采用，历史输入身份仍有效", async () => {
    const round = await valid_round();
    await server.sdlcs.archive("simple-sdlc", 1);
    expect(await server.coordination.get("REQ-CONTEXT", round.round_id)).toMatchObject({ current: true, adoptable: false, adoption_reason: "绑定的 SDLC 版本已归档" });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
  });

  it.each(["wait", "ask_human"])("%s 是有效 Draft，但不能制造节点推进或人工 gate 决策", async (kind) => {
    await config(JSON.stringify({ ...proposal, next_action: { kind, reason: "需要人工补充事实", evidence: proposal.next_action.evidence,
      ...(kind === "ask_human" ? { question: "是否采用该范围？", options: ["采用", "调整"] } : {}) } }));
    await server.agents.reload();
    const round = await valid_round();
    expect(round).toMatchObject({ current: true, adoptable: false });
    expect((await adopt(round.round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "gate.resolved" || event.type === "workflow.node.exited")).toBe(false);
  });

  it("没有配置身份的旧成功事件不能被采用", async () => {
    const session = await server.sessions.open("REQ-CONTEXT");
    const round_id = ulid();
    for (const [type, payload] of [
      ["coordinator.round.requested", { round_id, workflow_id: "simple-sdlc", driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }],
      ["coordinator.round.completed", { round_id, workflow_id: "simple-sdlc", driver: "coordinator", status: "ok", proposal, error: null, duration_ms: 1, input_hash: "a".repeat(64) }],
    ] as const) await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "system", id: "legacy" }, correlation_id: round_id, payload, source: { adapter: "test" } });
    expect(await server.coordination.get("REQ-CONTEXT", round_id)).toMatchObject({ current: null, adoptable: false });
    expect((await adopt(round_id)).status).toBe(409);
  });

  it("旧前缀策略的成功提议保留历史，重启后必须重新协调才可采用", async () => {
    const current = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    const binding = await server.sdlcs.get("simple-sdlc", 1);
    const snapshot = await readSnapshot(session, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision,
      files: binding.def.spec.nodes.flatMap((node) => node.artifact === undefined ? [] : [node.artifact]) });
    const legacy_hash = sha256Hex(canonicalJson({ domain: "cord.coordination-input.v1", workflow: binding.def,
      configuration_hash: current.agent_configuration_hash, max_prompt_chars: 60_000, workflow_revision: binding.workflow_revision,
      req_id: snapshot.req_id, title: snapshot.title, docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
      ledger: snapshot.ledger, workflow_progress: { ...snapshot.workflow, waiting: snapshot.workflow.waiting ?? [] } }));
    const round_id = ulid();
    for (const [type, payload] of [
      ["coordinator.round.requested", { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision,
        driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }],
      ["coordinator.round.completed", { round_id, workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision,
        driver: "headless:coordinator", status: "ok", proposal, error: null, duration_ms: 1, input_hash: legacy_hash,
        agent_configuration_hash: current.agent_configuration_hash }],
    ] as const) await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1",
      actor: { kind: "system", id: "legacy" }, correlation_id: round_id, payload, source: { adapter: "test" } });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", round_id)).toMatchObject({ status: "ok", proposal, current: false, adoptable: false });
    expect((await adopt(round_id)).status).toBe(409);
    expect(server.runs.listRuns("REQ-CONTEXT")).toHaveLength(0);
    expect(await valid_round()).toMatchObject({ current: true, adoptable: true });
  });

  it("采用事实必须匹配提议的 workflow/节点/输入，不能因错误引用伪装成已采用", async () => {
    const round = await valid_round();
    const session = await server.sessions.open("REQ-CONTEXT");
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.adopted", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round.round_id,
      payload: { round_id: round.round_id, workflow_id: "OTHER_WORKFLOW", node_id: "intake", input_hash: round.input_hash, run_id: ulid() }, source: { adapter: "test" } });
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${round.round_id}`)).status).toBe(500);
  });

  it.each([false, true])("登记与派发间中断后，采用事实存在=%s 决定是否恢复 runner", async (recorded) => {
    const round = await valid_round();
    const run_id = ulid();
    server.index.insertRun({ run_id, req_id: "REQ-CONTEXT", sdlc_id: "simple-sdlc", sdlc_version: 1, status: "running", started_at: new Date().toISOString(), finished_at: null, error: null, coordination_round_id: round.round_id, workflow_revision: round.workflow_revision });
    const session = await server.sessions.open("REQ-CONTEXT");
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.started", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: run_id,
      payload: { run_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision, sdlc_id: "simple-sdlc", sdlc_version: 1, coordination_round_id: round.round_id }, source: { adapter: "test" } });
    if (recorded) {
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.adopted", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round.round_id,
        payload: { round_id: round.round_id, workflow_id: round.workflow_id, workflow_revision: round.workflow_revision, node_id: "intake", input_hash: round.input_hash, run_id }, source: { adapter: "test" } });
    }
    await restart();
    if (recorded) {
      await wait_for(async () => (await server.sessions.listApprovals("REQ-CONTEXT")).length === 1);
      expect(server.runs.activeRunId("REQ-CONTEXT")).toBe(run_id);
      expect((await server.coordination.get("REQ-CONTEXT", round.round_id)).adopted_run_id).toBe(run_id);
    } else {
      expect(await server.runs.getRun(run_id)).toMatchObject({ status: "failed", error: "协调采用事实缺失或版本不匹配，未恢复派发" });
      expect(server.runs.isActive("REQ-CONTEXT")).toBe(false);
      expect((await server.sessions.readEvents("REQ-CONTEXT")).some((event) => event.type === "workflow.node.entered")).toBe(false);
    }
  });
});

describe("Context Session Agent REST", () => {
  it("Codex 非终态配置通知保留辅助通道，协调仍得到严格 JSON 与会话身份", async () => {
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: { kind: "headless", bin: process.execPath,
      args: [fixture, "--mode", "codex-warning", "--no-tools", "--result-text", JSON.stringify(proposal), "{{prompt}}"] } } }));
    await server.agents.reload(); const result = await start();
    expect(await done(result.body.round.round_id)).toMatchObject({ status: "ok", proposal });
    const completion = (await server.sessions.readEvents("REQ-CONTEXT")).find((event) => event.type === "coordinator.round.completed");
    expect(completion?.payload).toMatchObject({ agent_session_id: "thread-1" });
    expect(JSON.stringify(completion?.payload)).not.toContain("NON_FATAL_CONFIGURATION_NOTICE");
  });
  it("终态查询返回时后台槽位已释放，连续发起无需额外等待或固定延迟", async () => {
    for (let index = 0; index < 3; index++) {
      const response = await start(`consecutive-${index}`);
      expect(response.status).toBe(202);
      expect((await done(response.body.round.round_id)).status).toBe("ok");
    }
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(3);
  });
  it("创建异步轮次 → 成功提议 → 事件投影，提议不推进 workflow 或改变文档", async () => {
    const original = await readFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "utf8");
    const response = await start();
    expect(response.status).toBe(202);
    const round = await done(response.body.round.round_id);
    expect(round).toMatchObject({ status: "ok", proposal, req_id: "REQ-CONTEXT", sdlc_id: "simple-sdlc", sdlc_version: 1, workflow_id: "simple-sdlc", driver: "headless:coordinator" });
    expect(round.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(round.agent_configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(round.source_hash).toBeNull();
    expect(await readFile(join(root, "cord", "REQ-CONTEXT", "prd.md"), "utf8")).toBe(original);
    expect((await request("GET", "/api/v1/requirements/REQ-CONTEXT/coordination")).body.rounds).toHaveLength(1);
    const events = await server.sessions.readEvents("REQ-CONTEXT");
    expect(events.filter((event) => event.type.startsWith("coordinator.round.")).map((event) => event.type)).toEqual(["coordinator.round.requested", "coordinator.round.started", "coordinator.round.completed"]);
    for (const event of events.filter((event) => event.type.startsWith("coordinator.round."))) expect(EVENT_PAYLOAD_SCHEMAS[event.type as EventType]?.safeParse(event.payload).success).toBe(true);
    expect(events.some((event) => event.type.startsWith("workflow.node.") || event.type.startsWith("agent.task."))).toBe(false);
    await server.sessions.readLedger("REQ-CONTEXT");
    expect((await request("POST", "/api/v1/doctor")).body.ok).toBe(true);
  });

  it("自定义 ACP 协调 agent 每轮 session/new，最新 PRD 注入而不 session/load", async () => {
    const record_file = join(root, "acp-messages.jsonl");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { coordinator: {
      kind: "acp", bin: process.execPath, args: [acp_fixture, "--no-tools", "--result-text", JSON.stringify(proposal), "--record", record_file],
    } } }));
    await server.agents.reload();
    await request("PUT", "/api/v1/requirements/REQ-CONTEXT/docs/prd", { content: "CURRENT_CONTEXT\n" + "x".repeat(40_000) + "\nTAIL_ACP_VERSION_A" }, "long-acp-context");
    const first = await start();
    expect(await done(first.body.round.round_id)).toMatchObject({ status: "ok", proposal, driver: "acp:coordinator" });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).toMatchObject({ current: true, adoptable: true });
    await request("PUT", "/api/v1/requirements/REQ-CONTEXT/docs/prd", { content: "LATEST_ACP_CONTEXT\n" + "x".repeat(40_000) + "\nTAIL_ACP_VERSION_B" }, "update-acp-context");
    expect(await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).toMatchObject({ current: false, adoptable: false });
    const second = await start("acp-second-round");
    expect((await done(second.body.round.round_id)).status).toBe("ok");
    const records = (await readFile(record_file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((item) => item.event === "session/new")).toHaveLength(2);
    expect(records.some((item) => item.event === "session/load")).toBe(false);
    const prompts = records.filter((item) => item.event === "prompt");
    expect(prompts[0].text).toContain("CURRENT_CONTEXT");
    expect(prompts[0].text.includes("TAIL_ACP_VERSION_A")).toBe(true);
    expect(prompts[1].text).toContain("LATEST_ACP_CONTEXT");
    expect(prompts[1].text.includes("TAIL_ACP_VERSION_B")).toBe(true);
    expect(prompts[1].text).not.toContain("CURRENT_CONTEXT");
  });

  it("需要幂等键，并发同键请求只创建一轮；重启后重放返回原响应", async () => {
    expect((await request("POST", "/api/v1/requirements/REQ-CONTEXT/coordination", { agent: "coordinator" })).status).toBe(400);
    const results = await Promise.all([start("same-key"), start("same-key"), start("same-key")]);
    expect(results.map((item) => item.status)).toEqual([202, 202, 202]);
    expect(new Set(results.map((item) => item.body.round.round_id)).size).toBe(1);
    await done(results[0]!.body.round.round_id);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(1);
    await restart();
    const replay = await start("same-key");
    expect(replay.body).toEqual(results[0]!.body);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(1);
    expect((await request("POST", "/api/v1/agents/reload", undefined, "same-key")).status).toBe(409);
  });

  it("每需求至多一轮在途协调，取消后可新建", async () => {
    await config(JSON.stringify(proposal), 2_000);
    await server.agents.reload();
    const first = await start();
    expect(first.status).toBe(202);
    expect((await start("another-round")).status).toBe(409);
    const cancelled = await request("POST", `/api/v1/requirements/REQ-CONTEXT/coordination/${first.body.round.round_id}/cancel`, undefined, "cancel-round");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.round.status).toBe("cancelled");
    await config();
    await server.agents.reload();
    const next = await start("new-round");
    expect(next.status).toBe(202);
    expect((await done(next.body.round.round_id)).status).toBe("ok");
  });

  it("取消先落事实、重复并发取消仅一条请求与终态；超时终态不同", async () => {
    await config(JSON.stringify(proposal), 2_000);
    await server.agents.reload();
    const first = await start();
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).status === "running");
    const url = `/api/v1/requirements/REQ-CONTEXT/coordination/${first.body.round.round_id}/cancel`;
    const results = await Promise.all([request("POST", url, undefined, "cancel-1"), request("POST", url, undefined, "cancel-2")]);
    expect(results.every((item) => item.body.round.status === "cancelled")).toBe(true);
    expect((await request("POST", url, undefined, "cancel-3")).body.round.status).toBe("cancelled");
    const events = (await server.sessions.readEvents("REQ-CONTEXT")).filter((event) => (event.payload as { round_id?: string })?.round_id === first.body.round.round_id);
    expect(events.filter((event) => event.type === "coordinator.round.cancel_requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "coordinator.round.completed")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "coordinator.round.cancel_requested")).toBeLessThan(events.findIndex((event) => event.type === "coordinator.round.completed"));
    const timeout = await start("timeout-round", { timeout_ms: 50 });
    expect((await done(timeout.body.round.round_id)).status).toBe("timeout");
  });

  it("坏输出有 failed/output 事实，修改配置后新轮次恢复", async () => {
    await config("NON_JSON_OUTPUT_DO_NOT_PERSIST");
    await server.agents.reload();
    const failed = await start();
    expect(await done(failed.body.round.round_id)).toMatchObject({ status: "failed", failure_stage: "output", proposal: null });
    expect(JSON.stringify(await server.sessions.readEvents("REQ-CONTEXT"))).not.toContain("NON_JSON_OUTPUT_DO_NOT_PERSIST");
    await config();
    await server.agents.reload();
    const recovered = await start("recovery");
    expect((await done(recovered.body.round.round_id)).status).toBe("ok");
  });

  it("文档在途更新导致 stale，新轮次恢复；重载不改变在途协调 driver", async () => {
    await config(JSON.stringify(proposal), 300);
    await server.agents.reload();
    const first = await start();
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", first.body.round.round_id)).status === "running");
    expect((await request("PUT", "/api/v1/requirements/REQ-CONTEXT/docs/prd", { content: "# PRD\nUPDATED_INPUT" }, "update-prd")).status).toBe(200);
    expect((await done(first.body.round.round_id)).status).toBe("stale");
    const next = await start("fixed-input");
    await wait_for(async () => (await server.coordination.get("REQ-CONTEXT", next.body.round.round_id)).status === "running");
    const original_hash = (await server.coordination.get("REQ-CONTEXT", next.body.round.round_id)).agent_configuration_hash;
    const new_proposal = { ...proposal, summary: "NEW_DRIVER_CONFIGURATION" };
    await config(JSON.stringify(new_proposal));
    await server.agents.reload();
    expect(await done(next.body.round.round_id)).toMatchObject({ status: "ok", proposal, agent_configuration_hash: original_hash });
    const new_round = await start("new-config");
    const new_result = await done(new_round.body.round.round_id);
    expect(new_result.proposal).toEqual(new_proposal);
    expect(new_result.agent_configuration_hash).not.toBe(original_hash);
  });

  it("未完成请求在重启后明确 interrupted，取消请求恢复为 cancelled，不重放 driver", async () => {
    const session = await server.sessions.open("REQ-CONTEXT");
    const interrupted_id = ulid();
    const cancelled_id = ulid();
    for (const round_id of [interrupted_id, cancelled_id]) {
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.requested", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: round_id,
        payload: { round_id, workflow_id: "simple-sdlc", driver: "coordinator", sdlc_id: "simple-sdlc", sdlc_version: 1 }, source: { adapter: "test" } });
    }
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "coordinator.round.cancel_requested", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: cancelled_id, payload: { round_id: cancelled_id }, source: { adapter: "test" } });
    await restart();
    expect(await server.coordination.get("REQ-CONTEXT", interrupted_id)).toMatchObject({ status: "failed", failure_stage: "interrupted", proposal: null });
    expect(await server.coordination.get("REQ-CONTEXT", cancelled_id)).toMatchObject({ status: "cancelled", failure_stage: "interrupted", proposal: null });
    const before = await server.sessions.readEvents("REQ-CONTEXT");
    expect(before.some((event) => event.type === "coordinator.round.started")).toBe(false);
    await restart();
    expect((await server.sessions.readEvents("REQ-CONTEXT")).length).toBe(before.length);
    const fresh = await start("after-restart");
    expect((await done(fresh.body.round.round_id)).status).toBe("ok");
  });

  it("参数、需求、轮次和归档版本错误具有明确 HTTP 状态", async () => {
    expect((await start("bad-options", { timeout_ms: 0 })).status).toBe(400);
    expect((await start("unknown-property", { execute: "shell" })).status).toBe(400);
    expect((await request("POST", "/api/v1/requirements/NO-REQ/coordination", { agent: "coordinator" }, "missing-req")).status).toBe(404);
    expect((await request("GET", `/api/v1/requirements/REQ-CONTEXT/coordination/${ulid()}`)).status).toBe(404);
    await server.sdlcs.archive("simple-sdlc", 1);
    expect((await start("archived")).status).toBe(409);
    expect((await server.coordination.list("REQ-CONTEXT"))).toHaveLength(0);
  });
});
