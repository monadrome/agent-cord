import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDefSchema, type WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import type { CheckerContext, SessionHandle } from "../../src/core/ports.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { readApprovalContextHash } from "../../src/coordinator/checkpoint.js";
import { createBuiltinRegistry } from "../../src/workflow/checkers.js";
import { parseWorkflow } from "../../src/workflow/loader.js";
import { stringify } from "yaml";
import { evaluateGate, createExecutor } from "../../src/workflow/executor.js";

let root: string; let session: SessionHandle; let def: WorkflowDef; let run_id: string;
const revision = "a".repeat(64); const config = "b".repeat(64);
const report = "## 变更\n实现value.txt。\n## 验收\n宿主测试。\n## 风险\n等待最终review。\n";
function definition() {
  return WorkflowDefSchema.parse({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-ready-checker" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "fake", input_scope: { kind: "dependencies" }, goal: { inputs: ["value.txt"],
      checks: [{ id: "tests", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8')!=='fixed')process.exit(3)"] }] } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], gates: [{ id: "human", role: {}, attach: { node: "review", when: "post" },
      checks: [{ ref: "goal-ready", with: { node_id: "deliver" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "side", gates: [] },
  ] } });
}
async function identity() {
  const source_hash = sha256Hex(await readFile(join(root, "value.txt"), "utf8"));
  const context_hash = await readApprovalContextHash(def, def.spec.nodes[0]!, session, config, revision);
  return { input_hash: sha256Hex(canonicalJson({ source_hash, context_hash })), source_hash };
}
async function input() { return { workflow: def, workflow_revision: revision, ...await identity(), artifact_hash: sha256Hex(await readFile(join(session.dir, "review.md"), "utf8")) }; }
function ctx(extra: Partial<CheckerContext> = {}): CheckerContext { return { session_dir: session.dir, session, workflow_id: def.metadata.id, workflow_revision: revision,
  node_id: "review", run_id, input_hash: "c".repeat(64), params: { node_id: "deliver" }, read_goal_input: input, anchors: [], payload: {}, ...extra }; }
const check = (context = ctx()) => createBuiltinRegistry().get("goal-ready")!.check(context);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-goal-ready-checker-")); session = await initSession(join(root, "cord"), "REQ-GOAL-READY");
  await writeFile(join(root, "value.txt"), "fixed"); await writeFile(join(session.dir, "prd.md"), "# PRD\n实现当前业务。\n");
  def = definition(); run_id = ulid();
  const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => ({ name: "fake", configuration_hash: config,
    async *run() { yield { type: "result", data: { text: report } }; }, async *resume() {} }), read_verification_input: identity });
  expect((await runner.runNode(def.spec.nodes[0]!, session, { workflow_id: def.metadata.id, workflow_revision: revision, node_id: "deliver", run_id })).status).toBe("ok");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("跨节点当前Goal就绪门禁", () => {
  it("当前上游ready通过，自身post也可核验；报告变化不影响上游就绪", async () => {
    expect((await check()).result).toBe("pass"); expect((await check(ctx({ node_id: "deliver" }))).result).toBe("pass");
    await writeFile(join(session.dir, "findings.md"), "# DOWNSTREAM_REPORT\n"); expect((await check()).result).toBe("pass");
  });
  it.each(["source", "prd", "guide", "configuration", "unavailable"])("当前%s变化拒绝旧ready，输入恢复后可重检", async mode => {
    if (mode === "source") await writeFile(join(root, "value.txt"), "changed");
    if (mode === "prd") await writeFile(join(session.dir, "prd.md"), "# CHANGED_PRD\n");
    if (mode === "guide") await writeFile(join(session.dir, "review.md"), "# CHANGED_GUIDE\n");
    const context = mode === "configuration" ? ctx({ read_goal_input: async () => ({ ...await input(), input_hash: "d".repeat(64) }) })
      : mode === "unavailable" ? ctx({ read_goal_input: async () => { throw Error("PRIVATE_FAILURE"); } }) : ctx();
    const result = await check(context); expect(result.result).toBe("block"); expect(result.reason).not.toContain("PRIVATE_FAILURE");
  });
  it.each([{}, { node_id: "unknown" }, { node_id: "side" }, { node_id: "deliver", extra: true }])("非法目标/参数%j拒绝", async params => {
    expect((await check(ctx({ params }))).result).toBe("block");
  });
  it.each(["hook", "workflow", "revision", "run", "consumer", "side", "malformed"])("缺失/错误%s来源不猜测放行", async mode => {
    const context = ctx();
    if (mode === "hook") delete context.read_goal_input;
    if (mode === "workflow") context.workflow_id = "foreign";
    if (mode === "revision") context.workflow_revision = "d".repeat(64);
    if (mode === "run") context.run_id = ulid();
    if (mode === "consumer") delete context.node_id;
    if (mode === "side") context.node_id = "side";
    if (mode === "malformed") context.read_goal_input = async () => ({ ...await input(), source_hash: "invalid" });
    expect((await check(context)).result).toBe("block");
  });
  it.each(["goal_actor", "task_actor", "verify_actor", "verify_hash", "worker_reference", "future_source"])("伪造%s不能作为完整ready证明", async mode => {
    const read = session.events.readOrderedStrict!.bind(session.events);
    vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => (await read()).map(event => {
      if (mode === "goal_actor" && event.type === "goal.attempt.completed") return { ...event, actor: { kind: "agent", id: "fake" } };
      if (mode === "task_actor" && event.type === "agent.task.completed") return { ...event, actor: { kind: "system", id: "fake" } };
      if (mode === "verify_actor" && event.type === "verification.completed") return { ...event, actor: { kind: "agent", id: "fake" } };
      if (mode === "verify_hash" && event.type === "verification.completed") return { ...event, payload: { ...event.payload, command_hash: "d".repeat(64) } };
      if (mode === "worker_reference" && event.type === "goal.attempt.completed") return { ...event, payload: { ...event.payload, completion_event_id: ulid() } };
      if (mode === "future_source" && event.type === "goal.attempt.completed") return { ...event, payload: { ...event.payload, verification_event_ids: [ulid()] } };
      return event;
    }));
    expect((await check()).result).toBe("block");
  });
  it("最新Goal失败不回退早先ready", async () => {
    const ready = (await session.events.readOrdered()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: ready.type, schema_version: "1", actor: ready.actor, correlation_id: ready.correlation_id,
      source: ready.source, payload: { ...ready.payload, status: "blocked", reason: "budget", failure_kind: "budget" } });
    expect((await check()).result).toBe("block");
  });
  it.each(["cancel", "verification", "strict-read"])("宿主读取输入期间%s使历史ready失效", async mode => {
    const read_goal_input = async () => {
      const result = await input();
      if (mode === "strict-read") vi.spyOn(session.events, "readOrderedStrict").mockRejectedValue(new Error("PRIVATE_READ_FAILURE"));
      else {
        const source = (await session.events.readOrdered()).filter(event => event.type === "verification.completed").at(-1)!;
        await session.events.append({ event_id: ulid(), session_id: session.req_id, type: mode === "cancel" ? "workflow.run.cancelled" : source.type,
          schema_version: "1", actor: { kind: "system", id: "goal-runner" }, correlation_id: "deliver", source: source.source,
          payload: mode === "cancel" ? { workflow_id: def.metadata.id, workflow_revision: revision, run_id } : { ...source.payload, status: "failed", exit_code: 3 } });
      }
      return result;
    };
    const result = await check(ctx({ read_goal_input })); expect(result.result).toBe("block"); expect(result.reason).not.toContain("PRIVATE_READ_FAILURE");
  });
  it("事件在宿主input读取期间被替换时拒绝，不采用旧快照", async () => {
    const read_goal_input = async () => {
      const result = await input(); const ready = (await session.events.readOrdered()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
      await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "goal.attempt.started", schema_version: "1", actor: ready.actor,
        correlation_id: "deliver", source: ready.source, payload: { workflow_id: def.metadata.id, workflow_revision: revision, run_id, node_id: "deliver", attempt: 2 } });
      return result;
    };
    expect((await check(ctx({ read_goal_input }))).result).toBe("block");
  });
  it("当前就绪证据被同内容新ready替换时evaluation身份变化", async () => {
    const gate = def.spec.nodes[1]!.gates[0]!; const context = ctx();
    const before = await evaluateGate(gate, createBuiltinRegistry(), context, context.input_hash);
    const ready = (await session.events.readOrdered()).filter(event => event.type === "goal.attempt.completed").at(-1)!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: ready.type, schema_version: "1", actor: ready.actor, correlation_id: ready.correlation_id, source: ready.source, payload: ready.payload });
    const after = await evaluateGate(gate, createBuiltinRegistry(), context, context.input_hash);
    expect(before.satisfied).toBe(true); expect(after.satisfied).toBe(true); expect(after.evaluation_hash).not.toBe(before.evaluation_hash);
  });
  it.each(["warn", "escalate", "any", "side", "missing-goal"])("发布与直接库执行拒绝%s绕过就绪要求", async mode => {
    const changed = structuredClone(def); const gate = changed.spec.nodes[1]!.gates[0]!;
    if (mode === "warn" || mode === "escalate") gate.on_fail = mode;
    if (mode === "any") gate.pass.require = "any";
    if (mode === "side") gate.checks[0]!.with = { node_id: "side" };
    if (mode === "missing-goal") delete changed.spec.nodes[0]!.run!.goal;
    expect(() => parseWorkflow(stringify(changed))).toThrow();
    await expect(createExecutor({ humanGate: { ask: async () => "确认放行" } }).run(changed, session)).rejects.toThrow();
  });
});
