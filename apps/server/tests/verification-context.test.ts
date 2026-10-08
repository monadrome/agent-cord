/** 机器观察只能来自当前声明/run/scope，不保留日志和不明输入。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSession, parseWorkflow, type SessionHandle, type WorkflowDef } from "agent-cord";
import YAML from "yaml";
import { readCoordinationVerifications } from "../src/services/verification-context.js";
import type { RunService } from "../src/services/run-service.js";

let root: string;
let session: SessionHandle;
const revision = "a".repeat(64);
const input_hash = "b".repeat(64);
const run_id = ulid();
const run = { run_id, req_id: "REQ-EVIDENCE", workflow_revision: revision, status: "waiting_human" };
const def: WorkflowDef = parseWorkflow(YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "evidence" }, spec: { nodes: [{ id: "verify", gates: [{
  id: "tests", role: {}, attach: { node: "verify", when: "post" }, checks: [
    { ref: "verification-passed", with: { verification_id: "unit-tests" } },
    { ref: "verification-passed", with: { verification_id: "lint" } },
  ], pass: { require: "all", human_confirm: true }, on_fail: "escalate",
}] }] } }));
const service = () => ({ latestRun: vi.fn(async () => run), configurationHashFor: vi.fn(() => null), readNodeInput: vi.fn(async () => ({ input_hash })) });
const read = (runs = service(), workflow = def) => readCoordinationVerifications(workflow, session, revision, runs as unknown as RunService);
async function record(overrides: Record<string, unknown> = {}) {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type: "verification.completed", schema_version: "1", actor: { kind: "system", id: "host" }, correlation_id: "verify",
    payload: { workflow_id: def.metadata.id, workflow_revision: revision, run_id, node_id: "verify", verification_id: "unit-tests", input_hash, command_hash: "c".repeat(64), status: "failed", exit_code: 1, summary: "PRIVATE_LOG", stdout: "PRIVATE_STDOUT", ...overrides }, source: { adapter: "host" } });
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-evidence-context-")); session = await initSession(join(root, "cord"), "REQ-EVIDENCE"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("协调机器观察投影", () => {
  it("缺失验证明确为 missing，最新失败和恢复状态可观察，私有字段丢弃", async () => {
    const missing = await read();
    expect(missing).toHaveLength(2);
    expect(missing.every((item) => item.status === "missing" && item.current === false)).toBe(true);
    const failed = await record();
    expect((await read()).find((item) => item.verification_id === "unit-tests")).toMatchObject({ event_id: failed.event_id, status: "failed", current: true, exit_code: 1 });
    const fixed = await record({ status: "passed", exit_code: 0 });
    const result = await read();
    expect(result.find((item) => item.verification_id === "unit-tests")).toMatchObject({ event_id: fixed.event_id, status: "passed", current: true });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("旧 run、旧发布版本和未声明验证不进入当前观察", async () => {
    await record({ run_id: ulid() });
    await record({ workflow_revision: "d".repeat(64) });
    await record({ verification_id: "foreign-check" });
    await record({ node_id: "foreign-node" });
    expect((await read()).every((item) => item.status === "missing")).toBe(true);
    const runs = service();
    runs.latestRun.mockResolvedValueOnce({ ...run, workflow_revision: "e".repeat(64) });
    expect((await read(runs)).every((item) => item.status === "missing" && item.run_id === null)).toBe(true);
  });

  it("源码/文档输入变化为 stale，无法验证为 unknown，取消运行的通过证据仍无效", async () => {
    await record({ status: "passed", exit_code: 0 });
    const runs = service();
    runs.readNodeInput.mockResolvedValueOnce({ input_hash: "d".repeat(64) });
    expect((await read(runs)).find((item) => item.verification_id === "unit-tests")).toMatchObject({ status: "passed", current: false, reason: "stale_input" });
    runs.readNodeInput.mockRejectedValueOnce(new Error("SOURCE_UNAVAILABLE"));
    expect((await read(runs)).find((item) => item.verification_id === "unit-tests")).toMatchObject({ current: null, reason: "unavailable" });
    runs.latestRun.mockResolvedValueOnce({ ...run, status: "cancelled" });
    expect((await read(runs)).find((item) => item.verification_id === "unit-tests")).toMatchObject({ current: false, reason: "run_cancelled" });
  });

  it.each([{ command_hash: undefined }, { status: "bogus" }, { input_hash: "z".repeat(64) }, { status: "passed", exit_code: 3 }])("坏的最新结果 %s 不回退历史通过", async (value) => {
    await record({ status: "passed", exit_code: 0 });
    await record(value);
    expect((await read()).find((item) => item.verification_id === "unit-tests")).toMatchObject({ status: "invalid", current: false, reason: "invalid_result" });
  });

  it("没有声明时不加载结果，超过观察上限拒绝读取", async () => {
    const unbound = structuredClone(def);
    unbound.spec.nodes[0]!.gates = [];
    const runs = service();
    expect(await read(runs, unbound)).toEqual([]);
    expect(runs.latestRun).not.toHaveBeenCalled();
    unbound.spec.nodes[0]!.gates = structuredClone(def.spec.nodes[0]!.gates);
    unbound.spec.nodes[0]!.gates[0]!.checks = Array.from({ length: 129 }, (_, index) => ({ ref: "verification-passed", with: { verification_id: `check-${index}` } }));
    await expect(read(runs, unbound)).rejects.toThrow(/128/);
  });

  it("取消事实先落盘但登记尚未更新时，观察仍按事实失效", async () => {
    await record({ status: "passed", exit_code: 0 });
    await session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.cancelled", schema_version: "1",
      actor: { kind: "human", id: "test" }, correlation_id: null, payload: { workflow_id: def.metadata.id, workflow_revision: revision, run_id }, source: { adapter: "test" } });
    expect((await read()).find((item) => item.verification_id === "unit-tests")).toMatchObject({ status: "passed", current: false, reason: "run_cancelled" });
  });
});
