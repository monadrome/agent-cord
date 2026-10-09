import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";
import { initSession } from "../../src/core/session.js";
import { WorkflowDefSchema, type WorkflowDef } from "../../src/core/schema.js";
import type { AgentDriver, AgentTask, SessionHandle } from "../../src/core/ports.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";
import { readApprovalContextHash } from "../../src/coordinator/checkpoint.js";
import { createExecutor } from "../../src/workflow/executor.js";

let root: string;
let session: SessionHandle;
const report = "# Human review\n\n## 变更\nvalue.txt 的业务值。\n\n## 验收\n按 PRD 检查目标值。\n\n## 风险\n仅覆盖声明输入，待最终人工 review。\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-goal-"));
  session = await initSession(join(root, "cord"), "REQ-GOAL");
  await writeFile(join(root, "value.txt"), "initial");
  await writeFile(join(session.dir, "prd.md"), "# 目标\n将 value.txt 改为 fixed，交付实际验证证据与 review 指南。\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function definition(overrides: Record<string, unknown> = {}): WorkflowDef {
  return WorkflowDefSchema.parse({
    apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "goal-flow" },
    spec: { nodes: [{ id: "deliver", artifact: "review.md", run: {
      agent: "fake", timeout_ms: 10_000, goal: {
        inputs: ["value.txt"], max_attempts: 3, timeout_ms: 30_000, no_progress_limit: 3,
        checks: [{ id: "value-test", bin: process.execPath, args: ["-e", "const fs = require('node:fs'); if(fs.readFileSync('value.txt', 'utf8') !== 'fixed') { console.error('TRUE_FAILURE'); process.exit(1); }"], timeout_ms: 5_000 }],
        ...overrides,
      },
    }, gates: [{ id: "human-review", role: {}, attach: { node: "deliver", when: "post" },
      checks: [{ ref: "verification-passed", with: { verification_id: "value-test" } }],
      pass: { human_confirm: true }, on_fail: "block" }] }] },
  });
}

function driver(action: (attempt: number, task: AgentTask) => Promise<string>): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return { name: "fake", configuration_hash: "a".repeat(64), prompts,
    async *run(task) { prompts.push(task.prompt); yield { type: "result", data: { text: await action(prompts.length, task), session_id: `s-${prompts.length}` } }; },
    async *resume() {},
  };
}

function setup(def: WorkflowDef, agent: AgentDriver) {
  const node = def.spec.nodes[0]!;
  const run_id = ulid();
  const ctx = { workflow_id: def.metadata.id, run_id, node_id: node.id };
  const read_input = async () => {
    const source_hash = sha256Hex(await readFile(join(root, "value.txt"), "utf8"));
    const context_hash = await readApprovalContextHash(def, node, session, agent.configuration_hash ?? null);
    return { source_hash, input_hash: sha256Hex(canonicalJson({ source_hash, context_hash })) };
  };
  const runner = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => agent, read_verification_input: read_input });
  return { runner, ctx, node, read_input };
}

async function latest_goal() { return (await session.events.readOrdered()).filter(e => e.type === "goal.attempt.completed").at(-1)!; }

describe("Goal 自主交付", () => {
  it("声明契约保留 goal，非法预算、空命令和只读 Goal 在派发前拒绝", () => {
    expect(definition().spec.nodes[0]!.run!.goal).toMatchObject({ max_attempts: 3, inputs: ["value.txt"] });
    for (const value of [{ checks: [] }, { max_attempts: 0 }, { inputs: [] }, { no_progress_limit: 0 }, { typo: true }]) {
      expect(() => definition(value)).toThrow();
    }
    const def = definition();
    def.spec.nodes[0]!.run!.readonly = true;
    expect(WorkflowDefSchema.safeParse(def).success).toBe(false);
  });

  it("实际测试失败后自主修复，不把模型声称全绿当完成，最终只等待人工终审", async () => {
    const agent = driver(async attempt => { await writeFile(join(root, "value.txt"), attempt === 1 ? "broken" : "fixed"); return report + "\n模型声称全部测试通过。"; });
    const def = definition(); const { runner, ctx, read_input } = setup(def, agent);
    const controller = new AbortController();
    let asked = 0;
    const executor = createExecutor({ run_id: ctx.run_id, nodeRunner: runner, signal: controller.signal,
      gateInputHash: async () => (await read_input()).input_hash,
      humanGate: { ask: async () => { asked++; controller.abort(); return "拒绝放行"; } },
    });
    await executor.run(def, session);
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain("TRUE_FAILURE");
    expect(asked).toBe(1);
    const events = await session.events.readOrdered();
    expect(events.filter(e => e.type === "verification.completed").map(e => e.payload["status"])).toEqual(["failed", "passed"]);
    expect((await latest_goal()).payload["status"]).toBe("ready");
    expect(events.some(e => e.type === "workflow.node.exited")).toBe(false);
    expect(events.some(e => e.type === "human.decision.recorded")).toBe(false);
    const guide = await readFile(join(session.dir, "review.md"), "utf8");
    expect(guide).toContain("宿主验证证据"); expect(guide).toContain("value-test");
    expect(events.filter(e => e.type.startsWith("goal.")).some(e => JSON.stringify(e).includes("TRUE_FAILURE"))).toBe(false);
  });

  it("相同 run 冷恢复复用就绪交付，代码变化使旧证据失效并重新执行", async () => {
    const agent = driver(async () => { await writeFile(join(root, "value.txt"), "fixed"); return report; });
    const def = definition(); const { runner, ctx, node } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    const completion = (await session.events.readOrdered()).filter(e => e.type === "agent.task.completed").at(-1)!;
    const fresh = setup(def, agent).runner;
    expect(await fresh.isCompletionReusable!(node, session, ctx, completion)).toBe(true);
    await writeFile(join(root, "value.txt"), "changed");
    expect(await fresh.isCompletionReusable!(node, session, ctx, completion)).toBe(false);
    expect((await fresh.runNode(node, session, ctx)).status).toBe("ok");
    expect(agent.prompts).toHaveLength(2);
    expect((await latest_goal()).payload["attempt"]).toBe(2);
    expect(await fresh.isCompletionReusable!(node, session, { ...ctx, run_id: ulid() }, completion)).toBe(false);
  });

  it("缺少非空 review 章节时自动补齐，测试全绿不能掩盖缺交付项", async () => {
    const agent = driver(async attempt => { await writeFile(join(root, "value.txt"), "fixed"); return attempt === 1 ? "# 测试全绿\n## 变更\n\n## 验收\n已测。\n" : report; });
    const def = definition(); const { runner, node, ctx } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain("指南");
  });

  it("重复失败达到无进展上限，恢复不重置尝试预算", async () => {
    const agent = driver(async () => report);
    const def = definition({ max_attempts: 5, no_progress_limit: 2 }); const { runner, node, ctx } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("failed");
    expect(agent.prompts).toHaveLength(2);
    expect((await latest_goal()).payload).toMatchObject({ status: "blocked", failure_kind: "no_progress" });
    const fresh = setup(def, agent).runner;
    expect((await fresh.runNode(node, session, ctx)).status).toBe("failed");
    expect(agent.prompts).toHaveLength(2);
  });

  it("代码已修改但返回空指南时继续补交付，旧文档不能顶替本次产物", async () => {
    const agent = driver(async attempt => { await writeFile(join(root, "value.txt"), "fixed"); return attempt === 1 ? "" : report; });
    const def = definition(); const { runner, node, ctx } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    expect(agent.prompts).toHaveLength(2);
    expect((await latest_goal()).payload["status"]).toBe("ready");
  });

  it("缺宿主验证能力与缺二进制都是阻塞，不进入无限修复", async () => {
    const agent = driver(async () => report); const def = definition(); const node = def.spec.nodes[0]!;
    const basic = createNodeRunner(def, { workspaceRoot: root, resolveDriver: () => agent });
    expect((await basic.runNode(node, session, { workflow_id: def.metadata.id, run_id: ulid(), node_id: node.id })).status).toBe("failed");
    expect(agent.prompts).toHaveLength(0);
    const absent = definition({ checks: [{ id: "missing", bin: "cord-nonexistent-test-command-73491", args: [], timeout_ms: 1000 }] });
    const { runner, ctx } = setup(absent, agent);
    expect((await runner.runNode(absent.spec.nodes[0]!, session, ctx)).status).toBe("failed");
    expect(agent.prompts).toHaveLength(1);
    expect((await latest_goal()).payload).toMatchObject({ status: "blocked", failure_kind: "environment" });
  });

  it("检查改动被测输入，即使退出码零也拒绝通过", async () => {
    const agent = driver(async () => { await writeFile(join(root, "value.txt"), "fixed"); return report; });
    const def = definition({ checks: [{ id: "mutation", bin: process.execPath, args: ["-e", "require('node:fs').writeFileSync('value.txt', String(Date.now()))"], timeout_ms: 1000 }] });
    const { runner, ctx, node } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("failed");
    expect((await latest_goal()).payload).toMatchObject({ status: "blocked", failure_kind: "input_changed" });
    expect((await session.events.readOrdered()).filter(e => e.type === "verification.completed").every(e => e.payload["status"] !== "passed")).toBe(true);
  });

  it("取消静默命令立即收束，测试没有被伪记通过", async () => {
    const agent = driver(async () => report);
    const def = definition({ checks: [{ id: "silent", bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeout_ms: 10000 }] });
    const { runner, node, ctx } = setup(def, agent); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try { expect((await runner.runNode(node, session, { ...ctx, signal: controller.signal })).status).toBe("cancelled"); }
    finally { clearTimeout(timer); }
    expect((await latest_goal()).payload["status"]).toBe("cancelled");
    expect((await session.events.readOrdered()).filter(e => e.type === "verification.completed").every(e => e.payload["status"] !== "passed")).toBe(true);
  });

  it("总时长耗尽停止静默 worker，不自动续加预算", async () => {
    const agent: AgentDriver = { name: "silent", async *run(task) {
      await new Promise<void>(resolve => { if (task.signal?.aborted) resolve(); else task.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    }, async *resume() {} };
    const def = definition({ timeout_ms: 100 }); const { runner, node, ctx } = setup(def, agent);
    expect((await runner.runNode(node, session, ctx)).status).toBe("timeout");
    expect((await latest_goal()).payload).toMatchObject({ status: "blocked", failure_kind: "budget" });
  });

  it("验证事实追加失败上抛，不伪造 ready 或继续模型尝试", async () => {
    const agent = driver(async () => { await writeFile(join(root, "value.txt"), "fixed"); return report; });
    const def = definition(); const { runner, node, ctx } = setup(def, agent);
    const original = session.events.append.bind(session.events);
    const append = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      if (draft.type === "verification.completed") throw new Error("verification fsync failure");
      return original(draft);
    });
    try { await expect(runner.runNode(node, session, ctx)).rejects.toThrow("verification fsync failure"); }
    finally { append.mockRestore(); }
    expect(agent.prompts).toHaveLength(1);
    expect((await session.events.readOrdered()).some(event => event.type === "goal.attempt.completed")).toBe(false);
    expect((await runner.runNode(node, session, ctx)).status).toBe("ok");
    expect((await latest_goal()).payload["attempt"]).toBe(2);
  });

  it("新验证事实替换原结果时即使声称通过，也不能复用原 Goal ready", async () => {
    const agent = driver(async () => { await writeFile(join(root, "value.txt"), "fixed"); return report; });
    const def = definition(); const { runner, node, ctx } = setup(def, agent);
    await runner.runNode(node, session, ctx);
    const events = await session.events.readOrdered();
    const completion = events.filter(event => event.type === "agent.task.completed").at(-1)!;
    const result = events.filter(event => event.type === "verification.completed").at(-1)!;
    await session.events.append({ event_id: ulid(), session_id: session.req_id, schema_version: "1", type: "verification.completed",
      correlation_id: node.id, actor: { kind: "system", id: "external-ci" }, source: { adapter: "external-ci" }, payload: result.payload });
    expect(await runner.isCompletionReusable!(node, session, ctx, completion)).toBe(false);
  });
});
