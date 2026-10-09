import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { parseWorkflow } from "../../src/workflow/loader.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { buildCoordinationPrompt, coordinationInputHash, parseCoordinationProposal } from "../../src/coordinator/session-agent.js";
import { createContextSessionAgent } from "../../src/coordinator/session-agent.js";
import type { AgentDriver, AgentEvent } from "../../src/core/ports.js";
import { CoordinationExecutionContextSchema, type CoordinationExecutionContext, type CoordinationProposal } from "../../src/core/schema.js";
import { initSession, type SessionHandle } from "../../src/core/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const def = parseWorkflow(`apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata: { id: goal-coordination }
spec:
  nodes:
    - id: deliver
      artifact: review.md
      run:
        agent: worker
        goal:
          inputs: [src]
          checks: [{ id: tests, bin: node, args: [--test] }]
      gates: []
    - id: done
      depends_on: [deliver]
      gates: []
`);
const blocked_id = ulid();
const blocked_run_id = ulid();
const blocked: CoordinationExecutionContext = CoordinationExecutionContextSchema.parse({
  run: { run_id: blocked_run_id, status: "failed", active: false },
  tasks: [{ node_id: "deliver", run_id: blocked_run_id, event_id: null, status: "missing", attempt: null, max_attempts: null, failure_stage: null, retryable: null }],
  goals: [{ node_id: "deliver", run_id: blocked_run_id, event_id: blocked_id, status: "blocked", attempt: 3, max_attempts: 3,
    failure_kind: "no_progress", reason: "连续无进展，需要人工决定是否补充事实", input_hash: "a".repeat(64), source_hash: "b".repeat(64), artifact_hash: null, verification_event_ids: [] }],
});
const waitProposal = (evidence: { source: "goal"; id: string }): CoordinationProposal => ({ summary: "Goal 已阻塞，等待人工决定", next_action: {
  kind: "ask_human", question: "是否补充测试事实或调整需求？", options: ["补充事实", "终止目标"], reason: "Goal 达到无进展上限", evidence: [evidence],
}, risks: ["继续执行前需要人工决定"] });

let root: string;
let session: SessionHandle;
async function snapshot() {
  return readSnapshot(session, { workflow_id: def.metadata.id, files: ["review.md"] });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-goal-observation-"));
  session = await initSession(join(root, "cord"), "REQ-GOAL-OBS");
  await writeFile(join(session.dir, "prd.md"), "# Goal\n目标交付\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("协调器 Goal 观察", () => {
  it("有验收清单的 ready 观察必须有完整覆盖，hook 缺项在模型调用前拒绝", async () => {
    const with_acceptance = structuredClone(def);
    with_acceptance.spec.nodes[0]!.run!.goal!.acceptance = [{ id: "baseline", criterion: "当前声明测试通过", checks: ["tests"] }];
    const execution = structuredClone(blocked); const verification_id = ulid();
    execution.goals[0] = { ...execution.goals[0]!, status: "ready", current: true, freshness_reason: "current", failure_kind: null,
      artifact_hash: "c".repeat(64), verification_event_ids: [verification_id], acceptance_evidence: [{ acceptance_id: "baseline", verification_event_ids: [verification_id] }] };
    const proposal = { summary: "等待最终 review", next_action: { kind: "wait", reason: "声明验收检查已通过", evidence: [{ source: "goal", id: blocked_id }] }, risks: [] };
    const snap = await snapshot();
    expect(parseCoordinationProposal(JSON.stringify(proposal), with_acceptance, snap, [], execution).next_action.kind).toBe("wait");
    expect(buildCoordinationPrompt(with_acceptance, snap, undefined, null, [], execution)).toContain("acceptance_evidence");
    delete execution.goals[0]!.acceptance_evidence;
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), with_acceptance, snap, [], execution)).toThrow(/验收覆盖/);
    expect(() => buildCoordinationPrompt(with_acceptance, snap, undefined, null, [], execution)).toThrow(/验收覆盖/);
    let calls = 0;
    const worker: AgentDriver = { name: "observer", configuration_hash: "d".repeat(64), async *run() { calls++; yield { type: "result", data: { text: JSON.stringify(proposal) } }; }, async *resume() {} };
    const agent = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_execution_context: async () => execution });
    expect(await agent.coordinate(with_acceptance, session, { round_id: ulid(), agent: worker.name })).toMatchObject({ status: "failed", proposal: null });
    expect(calls).toBe(0);
  });
  it("只有已核验的 ready 可引用，ready 新鲜度变化使旧协调身份失效", async () => {
    const execution = structuredClone(blocked);
    execution.goals[0] = { ...execution.goals[0], status: "ready", current: true, freshness_reason: "current", artifact_hash: "c".repeat(64), verification_event_ids: [ulid()] };
    const snap = await snapshot();
    const proposal = { summary: "等待最终 review", next_action: { kind: "wait", reason: "当前就绪", evidence: [{ source: "goal", id: blocked_id }] }, risks: [] };
    expect(parseCoordinationProposal(JSON.stringify(proposal), def, snap, [], execution).next_action.kind).toBe("wait");
    const original_hash = coordinationInputHash(def, snap, "c".repeat(64), undefined, null, [], execution);
    execution.goals[0].current = false; execution.goals[0].freshness_reason = "stale_input";
    expect(coordinationInputHash(def, snap, "c".repeat(64), undefined, null, [], execution)).not.toBe(original_hash);
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), def, snap, [], execution)).toThrow(/来源引用不可验证/);
  });

  it("模型调用期间只有 ready 新鲜度变化也会使本轮 stale，新轮次可恢复", async () => {
    let execution = structuredClone(blocked);
    execution.goals[0] = { ...execution.goals[0], status: "ready", current: true, freshness_reason: "current", artifact_hash: "c".repeat(64), verification_event_ids: [ulid()] };
    let calls = 0;
    const proposal = { summary: "等待最终 review", next_action: { kind: "wait", reason: "交付就绪观察", evidence: [{ source: "goal", id: blocked_id }] }, risks: [] };
    const worker: AgentDriver = { name: "ready-observer", configuration_hash: "d".repeat(64), async *run() {
      if (++calls === 1) { execution.goals[0].current = false; execution.goals[0].freshness_reason = "stale_input"; }
      yield { type: "result", data: { text: JSON.stringify(proposal) } };
    }, async *resume() {} };
    const agent = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root, read_execution_context: async () => structuredClone(execution) });
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: worker.name })).toMatchObject({ status: "stale", proposal: null });
    execution.goals[0].current = true; execution.goals[0].freshness_reason = "current";
    expect(await agent.coordinate(def, session, { round_id: ulid(), agent: worker.name })).toMatchObject({ status: "ok", proposal });
  });
  it.each([false, null, undefined])("ready 新鲜度 %s 时不能作为当前来源", async current => {
    const execution = structuredClone(blocked);
    execution.goals[0] = { ...execution.goals[0], status: "ready", current, freshness_reason: current === false ? "stale_input" : "unavailable" } as any;
    const proposal = { summary: "等待人审", next_action: { kind: "wait", reason: "交付观察", evidence: [{ source: "goal", id: blocked_id }] }, risks: [] };
    const snap = await snapshot();
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), def, snap, [], execution)).toThrow(/来源引用不可验证/);
  });
  it("Context Session Agent 收到 blocked Goal 后可提出带 Goal 证据的人工升级", async () => {
    const proposal = waitProposal({ source: "goal", id: blocked_id });
    const worker: AgentDriver = {
      name: "goal-observer", configuration_hash: "c".repeat(64),
      async *run() { yield { type: "result", data: { text: JSON.stringify(proposal), session_id: "goal-observer-session" } } satisfies AgentEvent; },
      async *resume() {},
    };
    const agent = createContextSessionAgent({ resolveDriver: () => worker, workspaceRoot: root,
      read_execution_context: async () => blocked });
    const result = await agent.coordinate(def, session, { round_id: ulid(), agent: worker.name });
    expect(result).toMatchObject({ status: "ok", proposal });
    expect((await session.events.readOrdered()).some(event => event.type === "workflow.node.exited")).toBe(false);
  });

  it("blocked/invalid/cancelled Goal 清空 eligible_nodes，advance fail-closed", async () => {
    const snap = await snapshot();
    const advance = { summary: "继续", next_action: { kind: "advance", node_id: "deliver", reason: "继续执行", evidence: [{ source: "workflow", id: "deliver" }] }, risks: [] };
    expect(() => parseCoordinationProposal(JSON.stringify(advance), def, snap, [], blocked)).toThrow(/不可推进/);
    const prompt = buildCoordinationPrompt(def, snap, 60_000, null, [], blocked);
    expect(prompt).toContain(`eligible_nodes: []`);
    expect(prompt).toContain(`status":"blocked"`);
    expect(prompt).toContain("不能 advance");
  });

  it("Goal 事件可作为当前人工升级证据，旧/未知 event_id 不能引用", async () => {
    const snap = await snapshot();
    const valid = waitProposal({ source: "goal", id: blocked_id });
    expect(parseCoordinationProposal(JSON.stringify(valid), def, snap, [], blocked)).toEqual(valid);
    const invalid = waitProposal({ source: "goal", id: ulid() });
    expect(() => parseCoordinationProposal(JSON.stringify(invalid), def, snap, [], blocked)).toThrow(/来源引用不可验证/);
  });

  it("Goal 状态进入 input hash；旧无 goals hook 仍保持兼容", async () => {
    const snap = await snapshot();
    const empty = CoordinationExecutionContextSchema.parse({ run: null, tasks: [] });
    expect(empty.goals).toEqual([]);
    expect(coordinationInputHash(def, snap, "c".repeat(64), undefined, null, [], blocked)).not.toBe(coordinationInputHash(def, snap, "c".repeat(64), undefined, null, [], empty));
    expect(buildCoordinationPrompt(def, snap, 60_000, null, [], empty)).not.toContain("status\\\":\\\"blocked");
  });

  it("Goal observation 归一化缺省字段，不携带日志或命令正文", () => {
    const parsed = CoordinationExecutionContextSchema.parse({ run: null, tasks: [], goals: [{ node_id: "deliver", run_id: null, event_id: null, status: "missing",
      attempt: null, max_attempts: null, failure_kind: null, reason: null, input_hash: null, source_hash: null, artifact_hash: null, verification_event_ids: [] }] });
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    expect(parsed.goals[0]).toMatchObject({ status: "missing", event_id: null });
  });
});
