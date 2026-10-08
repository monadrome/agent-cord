/** Context Session Agent：离线 driver + 真实事件/文档，验证结构化提议与新鲜度边界。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import type { AgentDriver, AgentEvent, AgentTask, SessionHandle } from "../../src/core/ports.js";
import { initSession } from "../../src/core/session.js";
import { EVENT_PAYLOAD_SCHEMAS, type CoordinationProposal, type CoordinationVerification, type EventType, type WorkflowDef } from "../../src/core/schema.js";
import { buildCoordinationPrompt, coordinationInputHash, createContextSessionAgent, parseCoordinationProposal } from "../../src/coordinator/session-agent.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";

const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "coordination" }, spec: { nodes: [
  { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
  { id: "plan", artifact: "design/plan.md", depends_on: ["intake"], gates: [] },
] } };
const proposal: CoordinationProposal = { summary: "需求已经明确", next_action: { kind: "advance", node_id: "intake", reason: "先确认需求", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
const verification_def = structuredClone(def);
verification_def.spec.nodes[0]!.gates = [{ id: "tests", role: { initiators: [], approvers: [] }, attach: { node: "intake", when: "post", triggers: [] },
  checks: [{ ref: "verification-passed", with: { verification_id: "offline-tests" } }], pass: { require: "all", human_confirm: true }, on_fail: "escalate", write_back: [] }];
const verification: CoordinationVerification = { run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "intake", verification_id: "offline-tests", event_id: "01ARZ3NDEKTSV4RRFFQ69G5F02",
  status: "failed", current: true, reason: "current", input_hash: "b".repeat(64), command_hash: "c".repeat(64), source_hash: null, exit_code: 1 };
const failure_proposal: CoordinationProposal = { summary: "当前测试失败，需要修复后重验", next_action: { kind: "wait", reason: "机器结果失败，等待修复",
  evidence: [{ source: "verification", id: verification.event_id! }] }, risks: [] };
let root: string;
let session: SessionHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-context-agent-"));
  session = await initSession(join(root, "cord"), "REQ-CONTEXT");
  await writeFile(join(session.dir, "prd.md"), "# PRD\nLATEST_REQUIREMENT");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function append(type: string, payload: Record<string, unknown>) {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null, payload, source: { adapter: "test" } });
}
function driver(events: AgentEvent[] = [{ type: "result", data: { text: JSON.stringify(proposal), session_id: "driver-round-1", usage: { input_tokens: 10 } } }]): AgentDriver & { tasks: AgentTask[] } {
  const tasks: AgentTask[] = [];
  return { name: "test-coordinator", configuration_hash: "a".repeat(64), tasks,
    async *run(task) { tasks.push(task); yield* events; },
    resume() { throw new Error("协调轮次不得 resume"); },
  };
}
function agent(worker: AgentDriver, maxOutputChars?: number) {
  return createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, ...(maxOutputChars !== undefined ? { maxOutputChars } : {}) });
}
function coordinate(worker: AgentDriver, input: { signal?: AbortSignal; timeout_ms?: number } = {}) {
  return agent(worker).coordinate(def, session, { round_id: ulid(), agent: "test-coordinator", ...input });
}

describe("独立协调轮次", () => {
  it("当前失败验证以受限数据进入 prompt，可作为 Draft 来源，轮次仅保存摘要", async () => {
    const worker = driver([{ type: "result", data: { text: JSON.stringify(failure_proposal) } }]);
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_verifications: async () => [verification] });
    expect(await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "ok", proposal: failure_proposal });
    expect(worker.tasks[0]?.prompt).toContain(`verifications: ${JSON.stringify([verification])}`);
    const completed = (await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")!;
    expect((completed.payload as any).verification_context_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(completed.payload).not.toHaveProperty("verifications");
    expect(JSON.stringify(completed.payload)).not.toContain(verification.command_hash!);
    const snapshot = await readSnapshot(session, { workflow_id: verification_def.metadata.id, files: ["prd.md", "design/plan.md"] });
    expect((completed.payload as any).input_hash).toBe(coordinationInputHash(verification_def, snapshot, worker.configuration_hash!, undefined, null, [verification]));
    expect(coordinationInputHash(verification_def, snapshot, worker.configuration_hash!, undefined, null, [])).toBe(coordinationInputHash(verification_def, snapshot, worker.configuration_hash!));
  });

  it.each(["unknown", "stale", "unavailable", "missing"])("%s 验证事件不能成为有效来源", async (kind) => {
    const observation: CoordinationVerification = { ...verification,
      ...(kind === "stale" ? { current: false, reason: "stale_input" as const } : {}),
      ...(kind === "unavailable" ? { current: null, reason: "unavailable" as const } : {}),
      ...(kind === "missing" ? { current: false, reason: "missing" as const, event_id: null, status: "missing" as const } : {}),
    };
    const output = kind === "unknown" ? { ...failure_proposal, next_action: { ...failure_proposal.next_action, evidence: [{ source: "verification", id: ulid() }] } } : failure_proposal;
    const worker = driver([{ type: "result", data: { text: JSON.stringify(output) } }]);
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_verifications: async () => [observation] });
    expect(await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect((await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")?.payload).toMatchObject({ failure_stage: "output" });
  });

  it("验证状态在途改变使提议 stale，后续新轮次使用最新机器观察", async () => {
    let observations = [verification];
    const worker = driver();
    worker.run = async function* (task) {
      worker.tasks.push(task);
      observations = [{ ...verification, event_id: "01ARZ3NDEKTSV4RRFFQ69G5F03", status: "passed", exit_code: 0 }];
      yield { type: "result", data: { text: JSON.stringify({ ...proposal, next_action: { kind: "wait", reason: "等待机器验证", evidence: [{ source: "workflow", id: "intake" }] } }) } };
    };
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_verifications: async () => observations });
    expect(await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "stale", proposal: null });
    expect((await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).status).toBe("ok");
    expect(worker.tasks[1]?.prompt).toContain('"status":"passed"');
  });

  it.each(["logs", "duplicate", "undeclared", "too-many", "unreadable", "nonzero-passed"])("非法宿主验证观察 %s 阻断派发，私有日志不进入事件", async (kind) => {
    const worker = driver();
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_verifications: async () => {
      if (kind === "unreadable") throw new Error("无法读取机器观察");
      if (kind === "logs") return [{ ...verification, summary: "PRIVATE_LOG" }] as any;
      if (kind === "nonzero-passed") return [{ ...verification, status: "passed", exit_code: 1 }];
      if (kind === "duplicate") return [verification, verification];
      if (kind === "undeclared") return [{ ...verification, verification_id: "foreign-check" }];
      return Array.from({ length: 129 }, (_, index) => ({ ...verification, verification_id: `tests-${index}` }));
    } });
    expect(await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect(worker.tasks).toHaveLength(0);
    expect(JSON.stringify(await session.events.readOrdered())).not.toContain("PRIVATE_LOG");
  });

  it("模型完成时验证观察无法读取，不能返回旧提议", async () => {
    const worker = driver([{ type: "result", data: { text: JSON.stringify(failure_proposal) } }]);
    let reads = 0;
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_verifications: async () => {
      if (++reads > 1) throw new Error("观察重检失败");
      return [verification];
    } });
    expect(await observer.coordinate(verification_def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect((await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")?.payload).toMatchObject({ failure_stage: "freshness" });
  });

  it("源码摘要纳入协调输入、prompt 和轮次 provenance，无范围保留原身份", async () => {
    const worker = driver();
    const source_hash = "d".repeat(64);
    const bound = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_source_hash: async () => source_hash });
    expect((await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).status).toBe("ok");
    expect(worker.tasks[0]?.prompt).toContain(`source_hash: ${source_hash}`);
    const rounds = (await session.events.readOrdered()).filter((event) => event.type.startsWith("coordinator.round."));
    expect(rounds[0]?.payload).toMatchObject({ source_hash });
    expect(rounds[1]?.payload).toMatchObject({ source_hash });
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id, files: ["prd.md", "design/plan.md"] });
    const bound_hash = coordinationInputHash(def, snapshot, worker.configuration_hash!, undefined, source_hash);
    expect((rounds[0]?.payload as any).input_hash).toBe(bound_hash);
    expect(coordinationInputHash(def, snapshot, worker.configuration_hash!, undefined, "e".repeat(64))).not.toBe(bound_hash);
    expect(coordinationInputHash(def, snapshot, worker.configuration_hash!, undefined, null)).toBe(coordinationInputHash(def, snapshot, worker.configuration_hash!));
    expect(buildCoordinationPrompt(def, snapshot, 12_000, source_hash).length).toBeLessThanOrEqual(12_000);
  });

  it("运行期间源码改变记 stale，下一轮基于新摘要恢复且不写旧提议", async () => {
    let source_hash = "d".repeat(64);
    const worker = driver();
    worker.run = async function* (task) {
      worker.tasks.push(task);
      source_hash = "e".repeat(64);
      yield { type: "result", data: { text: JSON.stringify(proposal) } };
    };
    const options = { resolveDriver: () => worker, workspaceRoot: root, read_source_hash: async () => source_hash };
    const bound = createContextSessionAgent(options);
    expect(await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "stale", proposal: null });
    const first = (await session.events.readOrdered()).filter((event) => event.type === "coordinator.round.completed")[0]!;
    expect(first.payload).toMatchObject({ source_hash: "d".repeat(64), failure_stage: "freshness" });
    expect((await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).status).toBe("ok");
    expect(worker.tasks[1]?.prompt).toContain(`source_hash: ${source_hash}`);
  });

  it.each(["invalid", "unreadable"])("源码摘要 %s 时不派发协调 driver", async (mode) => {
    const worker = driver();
    const bound = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_source_hash: async () => {
      if (mode === "unreadable") throw new Error("源码摘要不可读");
      return "invalid-hash";
    } });
    expect(await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect(worker.tasks).toHaveLength(0);
    expect((await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")?.payload).toMatchObject({ failure_stage: "snapshot" });
  });

  it.each([new Error("完成时源码不可读"), undefined])("完成时源码摘要读取失败 %s，不能返回提议", async (failure) => {
    const worker = driver();
    let reads = 0;
    const bound = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_source_hash: async () => {
      if (++reads > 1) throw failure;
      return "d".repeat(64);
    } });
    expect(await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect((await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")?.payload).toMatchObject({ failure_stage: "freshness" });
  });

  it("源码重检期间取消，返回 cancelled 且不保留提议", async () => {
    const controller = new AbortController();
    const worker = driver();
    let reads = 0;
    const bound = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_source_hash: async () => {
      if (++reads > 1) controller.abort();
      return "d".repeat(64);
    } });
    expect(await bound.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator", signal: controller.signal })).toMatchObject({ status: "cancelled", proposal: null });
  });

  it("成功只产提议，记录 provenance/hash，不推进节点或写文档，不注入事件正文", async () => {
    await append("cli.message.received", { kind: "message", text: "HISTORICAL_EVENT_BODY", argv: [], raw_id: "history" });
    const worker = driver();
    const original = await readFile(join(session.dir, "prd.md"), "utf8");
    const result = await coordinate(worker);
    expect(result).toMatchObject({ status: "ok", proposal, error: null });
    expect(worker.tasks[0]).toMatchObject({ readonly: true, cwd: root });
    expect(worker.tasks[0]?.prompt).toContain("LATEST_REQUIREMENT");
    expect(worker.tasks[0]?.prompt).not.toContain("HISTORICAL_EVENT_BODY");
    expect(await readFile(join(session.dir, "prd.md"), "utf8")).toBe(original);
    const events = await session.events.readOrdered();
    const rounds = events.filter((event) => event.type.startsWith("coordinator.round."));
    expect(rounds.map((event) => event.type)).toEqual(["coordinator.round.started", "coordinator.round.completed"]);
    for (const event of rounds) expect(EVENT_PAYLOAD_SCHEMAS[event.type as EventType]?.safeParse(event.payload).success).toBe(true);
    const started = rounds[0]!.payload as Record<string, unknown>;
    const completed = rounds[1]!.payload as Record<string, unknown>;
    expect(completed).toMatchObject({ input_hash: started.input_hash, prompt_hash: started.prompt_hash, snapshot_id: started.snapshot_id, agent_configuration_hash: "a".repeat(64), agent_session_id: "driver-round-1", usage: { input_tokens: 10 } });
    expect(JSON.stringify(started)).not.toContain("LATEST_REQUIREMENT");
    expect(JSON.stringify(completed)).not.toContain("response_schema");
    expect(events.some((event) => event.type.startsWith("workflow.node.") || event.type.startsWith("agent.task."))).toBe(false);
    expect(result.completed_event_id).toBe(rounds[1]!.event_id);
    await session.rebuildLedger();
    expect((await session.doctor()).ok).toBe(true);
  });

  it("每轮使用新会话与最新需求，不继承旧提议或上轮推理", async () => {
    const worker = driver([{ type: "result", data: { text: JSON.stringify({ ...proposal, summary: "PREVIOUS_REASONING" }) } }]);
    await coordinate(worker);
    await writeFile(join(session.dir, "prd.md"), "# PRD\nNEXT_REQUIREMENT");
    await coordinate(worker);
    expect(worker.tasks).toHaveLength(2);
    expect(worker.tasks[1]?.prompt).toContain("NEXT_REQUIREMENT");
    expect(worker.tasks[1]?.prompt).not.toContain("LATEST_REQUIREMENT");
    expect(worker.tasks[1]?.prompt).not.toContain("PREVIOUS_REASONING");
    expect(worker.tasks[1]?.session_id).toBeUndefined();
  });

  it.each([
    ["自由文本", "unstructured answer"], ["Markdown 围栏", `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``],
    ["任意命令", JSON.stringify({ ...proposal, execute: "rm -rf workspace" })],
    ["空最终文本", ""],
  ])("%s 失败且不把自由文本落入事实流", async (_name, text) => {
    const result = await coordinate(driver([{ type: "text", data: { text: JSON.stringify(proposal) } }, { type: "result", data: { text } }]));
    expect(result.status).toBe("failed");
    expect(result.proposal).toBeNull();
    const completed = (await session.events.readOrdered()).find((event) => event.type === "coordinator.round.completed")!;
    expect(completed.payload).toMatchObject({ failure_stage: "output", proposal: null });
    expect((completed.payload as Record<string, unknown>).text).toBeUndefined();
  });

  it("metadata 不作 fallback；内容通道可作无显式最终文本的 fallback", async () => {
    expect((await coordinate(driver([{ type: "text", data: { text: JSON.stringify(proposal), channel: "metadata" } }, { type: "result", data: { text: null } }]))).status).toBe("failed");
    expect((await coordinate(driver([{ type: "text", data: { text: JSON.stringify(proposal) } }, { type: "result", data: { text: null } }]))).status).toBe("ok");
  });

  it("需求在模型运行期间变化则 stale，不返回旧建议；新轮次可恢复", async () => {
    const worker = driver();
    worker.run = async function* (task) { worker.tasks.push(task); await writeFile(join(session.dir, "prd.md"), "# PRD\nCHANGED_IN_FLIGHT"); yield { type: "result", data: { text: JSON.stringify(proposal) } }; };
    expect(await coordinate(worker)).toMatchObject({ status: "stale", proposal: null });
    const recovered = driver();
    expect((await coordinate(recovered)).status).toBe("ok");
    expect(recovered.tasks[0]?.prompt).toContain("CHANGED_IN_FLIGHT");
  });

  it.each(["ledger", "workflow", "gate"])("%s 在途变化使提议 stale", async (kind) => {
    const worker = driver();
    worker.run = async function* () {
      if (kind === "ledger") await append("ledger.entry.proposed", { entry_id: "C-1", title: "新共识", anchors: [{ kind: "doc", anchor: "prd.md" }] });
      else if (kind === "workflow") await append("workflow.node.exited", { workflow_id: def.metadata.id, node_id: "intake" });
      else await append("gate.waiting", { workflow_id: def.metadata.id, node_id: "intake", gate_id: "human", question: "确认？", options: ["确认", "终止"] });
      yield { type: "result", data: { text: JSON.stringify(proposal) } };
    };
    expect(await coordinate(worker)).toMatchObject({ status: "stale", proposal: null });
  });

  it("快照、driver 配置与 driver 运行错误均落失败终态；修复后可重新协调", async () => {
    await rm(join(session.dir, "prd.md"));
    await mkdir(join(session.dir, "prd.md"));
    const worker = driver();
    expect((await coordinate(worker)).status).toBe("failed");
    expect(worker.tasks).toHaveLength(0);
    await rm(join(session.dir, "prd.md"), { recursive: true });
    await writeFile(join(session.dir, "prd.md"), "# Recovered");
    const unavailable = createContextSessionAgent({ resolveDriver: () => { throw new Error("配置不可解析"); }, workspaceRoot: root });
    expect((await unavailable.coordinate(def, session, { round_id: ulid(), agent: "missing" })).status).toBe("failed");
    expect((await coordinate(driver([{ type: "error", data: { kind: "agent", message: "模型不可用" } }]))).status).toBe("failed");
    expect((await coordinate(driver())).status).toBe("ok");
    const completed = (await session.events.readOrdered()).filter((event) => event.type === "coordinator.round.completed");
    expect(completed.map((event) => (event.payload as Record<string, unknown>).failure_stage)).toEqual(["snapshot", "configuration", "driver", undefined]);
  });

  it("静默 driver 取消和宿主超时都会收束迭代器，终态不同", async () => {
    let closed = 0;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const worker = driver();
    worker.run = () => { began(); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<AgentEvent>>(() => {}), return: async () => { closed++; return { done: true, value: undefined }; } }) }; };
    const controller = new AbortController();
    const pending = coordinate(worker, { signal: controller.signal });
    await started;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect((await coordinate(worker, { timeout_ms: 20 })).status).toBe("timeout");
    expect(closed).toBe(2);
  });

  it.each([
    { type: "text", data: { text: 42 } },
    { type: "result", data: { text: { shell: "arbitrary control" } } },
    { type: "error", data: null },
    { type: "result", data: { text: JSON.stringify(proposal), usage: { input_tokens: "not a number" } } },
  ] as AgentEvent[])("非法 driver 事件落 failed/driver，不能留下未校验终态", async (event) => {
    expect(await coordinate(driver([event]))).toMatchObject({ status: "failed", proposal: null });
    const completed = (await session.events.readOrdered()).find((item) => item.type === "coordinator.round.completed")!;
    expect(EVENT_PAYLOAD_SCHEMAS["coordinator.round.completed"]?.safeParse(completed.payload).success).toBe(true);
    expect(completed.payload).toMatchObject({ failure_stage: "driver" });
  });

  it("用量仅保存规范字段，不携带 driver raw 或额外字段", async () => {
    await coordinate(driver([{ type: "result", data: { text: JSON.stringify(proposal), usage: { input_tokens: 20, private_env: "DO_NOT_PERSIST" }, raw: { secret: "DO_NOT_PERSIST" } } }]));
    const events = await session.events.readOrdered();
    expect(JSON.stringify(events)).not.toContain("DO_NOT_PERSIST");
    expect(events.find((item) => item.type === "coordinator.round.completed")?.payload).toMatchObject({ status: "ok", usage: { input_tokens: 20 } });
  });

  it("超过输出上限会中止 driver，并拒绝提议", async () => {
    let aborted = false;
    const worker = driver();
    worker.run = async function* (task) { try { yield { type: "text", data: { text: "x".repeat(101) } }; } finally { aborted = task.signal?.aborted === true; } };
    expect((await agent(worker, 100).coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).status).toBe("failed");
    expect(aborted).toBe(true);
  });

  it("事件追加失败上抛，不伪造 completed 或继续派发", async () => {
    const worker = driver();
    const append_real = session.events.append.bind(session.events);
    vi.spyOn(session.events, "append").mockImplementation((draft) => draft.type === "coordinator.round.completed" ? Promise.reject(new Error("storage unavailable")) : append_real(draft));
    await expect(coordinate(worker)).rejects.toThrow("storage unavailable");
    expect((await session.events.readOrdered()).filter((event) => event.type === "coordinator.round.completed")).toHaveLength(0);
  });
});

describe("提议验证与上下文预算", () => {
  it("长 PRD 的开头与最新尾部要求都进入独立协调，不改变默认 worker 快照", async () => {
    const content = "HEAD_REQUIREMENT\n" + "x".repeat(40_000) + "\nLATEST_TAIL_REQUIREMENT";
    await writeFile(join(session.dir, "prd.md"), content);
    const worker = driver();
    expect((await coordinate(worker)).status).toBe("ok");
    expect(worker.tasks[0]?.prompt).toContain("HEAD_REQUIREMENT");
    expect(worker.tasks[0]?.prompt.includes("LATEST_TAIL_REQUIREMENT")).toBe(true);
    expect((await readSnapshot(session)).docs.find((doc) => doc.file === "prd.md")?.content).not.toContain("LATEST_TAIL_REQUIREMENT");
  });

  it("受限总预算同时覆盖各文档，片段范围可还原原文且显式披露省略", async () => {
    await mkdir(join(session.dir, "design"));
    const files = ["prd.md", "plan.md", "adr.md", "findings.md", "design/plan.md"];
    const contents = new Map(files.map((file, index) => [file, `HEAD_${index}\n` + "x".repeat(40_000) + `\nTAIL_${index}`]));
    for (const [file, content] of contents) await writeFile(join(session.dir, file), content);
    const worker = driver();
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, maxPromptChars: 12_000 });
    expect((await observer.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).status).toBe("ok");
    const prompt = worker.tasks[0]!.prompt;
    expect(prompt.length).toBeLessThanOrEqual(12_000);
    for (let index = 0; index < files.length; index++) {
      expect(prompt.includes(`HEAD_${index}`)).toBe(true);
      expect(prompt.includes(`TAIL_${index}`)).toBe(true);
    }
    const line = prompt.split("\n").find((item) => item.startsWith("document_excerpts: "));
    expect(line).toBeDefined();
    const entries = JSON.parse(line!.slice("document_excerpts: ".length));
    expect(entries).toHaveLength(files.length);
    for (const entry of entries) {
      const content = contents.get(entry.file)!;
      expect(entry.omitted_chars).toBeGreaterThan(0);
      expect(entry.included_chars + entry.omitted_chars).toBe(content.length);
      for (const [start, end] of entry.ranges) expect(prompt).toContain(content.slice(start, end));
    }
  });

  it("末尾要求在模型调用期间变化记 stale，新轮次能看到新尾部", async () => {
    const original = "HEAD_REQUIREMENT\n" + "x".repeat(40_000) + "\nTAIL_VERSION_A";
    await writeFile(join(session.dir, "prd.md"), original);
    const worker = driver();
    let changed = false;
    worker.run = async function* (task) {
      worker.tasks.push(task);
      if (!changed) { changed = true; await writeFile(join(session.dir, "prd.md"), original.replace("TAIL_VERSION_A", "TAIL_VERSION_B")); }
      yield { type: "result", data: { text: JSON.stringify(proposal) } };
    };
    expect(await coordinate(worker)).toMatchObject({ status: "stale", proposal: null });
    expect((await coordinate(worker)).status).toBe("ok");
    expect(worker.tasks[0]?.prompt.includes("TAIL_VERSION_A")).toBe(true);
    expect(worker.tasks[1]?.prompt.includes("TAIL_VERSION_B")).toBe(true);
    expect(worker.tasks[1]?.prompt).not.toContain("TAIL_VERSION_A");
  });

  it.each([NaN, Infinity, -1, 100])("预算 %s 无效或不足时不派发，默认预算可恢复", async (maxPromptChars) => {
    const worker = driver();
    const observer = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, maxPromptChars });
    expect(await observer.coordinate(def, session, { round_id: ulid(), agent: "test-coordinator" })).toMatchObject({ status: "failed", proposal: null });
    expect(worker.tasks).toHaveLength(0);
    expect((await coordinate(worker)).status).toBe("ok");
  });

  it("advance 只能选择执行器实际下一节点，不能选择拓扑中的另一个独立 ready 节点", async () => {
    const workflow = { ...def, spec: { nodes: [def.spec.nodes[0]!, { id: "parallel", depends_on: [], gates: [] }] } };
    const snapshot = await readSnapshot(session, { workflow_id: workflow.metadata.id });
    expect(() => parseCoordinationProposal(JSON.stringify({ ...proposal, next_action: { ...proposal.next_action, node_id: "parallel" } }), workflow, snapshot)).toThrow(/不可推进/);
    expect(buildCoordinationPrompt(workflow, snapshot)).toContain('eligible_nodes: ["intake"]');
  });
  it("拒绝未知节点、依赖未完成节点、完成节点和虚假的 complete", async () => {
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    for (const node_id of ["unknown", "plan"]) expect(() => parseCoordinationProposal(JSON.stringify({ ...proposal, next_action: { ...proposal.next_action, node_id } }), def, snapshot)).toThrow(/不可推进/);
    expect(() => parseCoordinationProposal(JSON.stringify({ ...proposal, next_action: { kind: "complete", reason: "结束", evidence: proposal.next_action.evidence } }), def, snapshot)).toThrow(/尚未完成/);
    await append("workflow.node.exited", { workflow_id: def.metadata.id, node_id: "intake" });
    await append("workflow.node.exited", { workflow_id: def.metadata.id, node_id: "plan" });
    const complete_snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), def, complete_snapshot)).toThrow(/不可推进/);
    expect(parseCoordinationProposal(JSON.stringify({ ...proposal, next_action: { kind: "complete", reason: "结束", evidence: proposal.next_action.evidence } }), def, complete_snapshot).next_action.kind).toBe("complete");
  });

  it("不存在的文档、未确认/冲突账本和虚假 workflow 来源都被拒绝", async () => {
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    for (const evidence of [{ source: "document", id: "events.jsonl" }, { source: "document", id: "absent.md" }, { source: "ledger", id: "C-1" }, { source: "workflow", id: "other" }]) {
      expect(() => parseCoordinationProposal(JSON.stringify({ ...proposal, next_action: { ...proposal.next_action, evidence: [evidence] } }), def, snapshot)).toThrow(/不可验证/);
    }
    await append("ledger.entry.proposed", { entry_id: "C-1", title: "有效共识", anchors: [{ kind: "doc", anchor: "prd.md" }] });
    await append("ledger.entry.confirmed", { entry_id: "C-1" });
    const text = JSON.stringify({ ...proposal, next_action: { ...proposal.next_action, evidence: [{ source: "ledger", id: "C-1" }] } });
    expect(parseCoordinationProposal(text, def, await readSnapshot(session)).summary).toBe(proposal.summary);
    await append("ledger.entry.confirmed", { entry_id: "C-1", expected_status: "overturned" });
    expect(() => parseCoordinationProposal(text, def, { ...snapshot, ledger: [{ entry_id: "C-1", title: "冲突", status: "confirmed", conflict: true }] })).toThrow(/不可验证/);
  });

  it("待人工 gate 阻止 advance，迟到旧 invalidated 不会消除新等待，其他 workflow 不污染", async () => {
    const waiting = await append("gate.waiting", { workflow_id: def.metadata.id, node_id: "intake", gate_id: "human" });
    await append("gate.waiting", { workflow_id: def.metadata.id, node_id: "intake", gate_id: "human" });
    await append("gate.invalidated", { workflow_id: def.metadata.id, node_id: "intake", gate_id: "human", waiting_event_id: waiting.event_id, reason: "旧等待过期" });
    await append("workflow.run.cancelled", { workflow_id: "other", run_id: "other-run" });
    const snapshot = await readSnapshot(session, { workflow_id: def.metadata.id });
    expect(snapshot.workflow.waiting).toHaveLength(1);
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), def, snapshot)).toThrow(/不可推进/);
    const ask = { ...proposal, next_action: { kind: "ask_human", question: "是否继续？", options: ["继续", "终止"], reason: "等待选择", evidence: [{ source: "workflow", id: "intake" }] } };
    expect(parseCoordinationProposal(JSON.stringify(ask), def, snapshot).next_action.kind).toBe("ask_human");
    expect(() => parseCoordinationProposal(JSON.stringify({ ...ask, next_action: { ...ask.next_action, options: ["继续", "继续"] } }), def, snapshot)).toThrow(/互不相同/);
  });

  it("上下文总预算硬限制，完整内容 hash 参与输入，序号与轮次事件不参与", async () => {
    await writeFile(join(session.dir, "prd.md"), "x".repeat(40_000));
    const snapshot = await readSnapshot(session);
    expect(buildCoordinationPrompt(def, snapshot, 12_000).length).toBeLessThanOrEqual(12_000);
    expect(() => buildCoordinationPrompt(def, snapshot, 100)).toThrow(/预算/);
    const baseline = coordinationInputHash(def, snapshot, "a".repeat(64));
    await append("cli.message.received", { text: "extra history" });
    expect(coordinationInputHash(def, await readSnapshot(session), "a".repeat(64))).toBe(baseline);
    expect(coordinationInputHash(def, snapshot, "b".repeat(64))).not.toBe(baseline);
    await writeFile(join(session.dir, "prd.md"), "x".repeat(40_000) + "tail change");
    expect(coordinationInputHash(def, await readSnapshot(session), "a".repeat(64))).not.toBe(baseline);
  });
});
