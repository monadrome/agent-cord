/** 只读报告经协调层代写后进入真实后置 gate，重启不会重复评审。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { ulid } from "ulid";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
let root: string; let server: BuiltServer;
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 10_000; while (!(await check())) { if (Date.now() > deadline) throw new Error("报告门禁观察超时"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
async function configure(text: string, sleep_ms = 0) {
  await mkdir(join(root, "cord"), { recursive: true }); await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { reviewer: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "codex-warning", ...(sleep_ms > 0 ? ["--sleep", String(sleep_ms)] : []), "--result-text", text, "{{prompt}}"] } } }));
}
async function start() {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/requirements/REQ-REPORT/runs", headers: { "content-type": "application/json", "idempotency-key": ulid() }, payload: JSON.stringify({ sdlc_id: "readonly-report" }) });
  expect(response.statusCode).toBe(202); return response.json().run;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-server-report-")); await configure("# 验证\n\n## 结论\n测试已执行，待人工确认。\n"); server = await buildApp({ root });
  await server.sessions.create("REQ-REPORT", "只读评审", "# 最新需求\n保持 worker 只读，宿主接收报告。");
  const workflow = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "readonly-report" }, spec: { nodes: [{ id: "review", artifact: "findings.md", run: { agent: "reviewer", readonly: true, output: "text" }, gates: [{ id: "review-report", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "doc-has-section", with: { path: "findings.md", heading: "结论" } }], pass: { require: "all", human_confirm: true }, on_fail: "block" }] }] } };
  await server.sdlcs.publish("readonly-report", YAML.stringify(workflow));
});
afterEach(async () => { for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id); await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });

async function bind_source() {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "draft.ts"), "export const version = 1;\n");
  const workflow = YAML.parse((await server.sdlcs.get("readonly-report", 1)).yaml);
  workflow.spec.nodes[0].gates[0].checks.push({ ref: "verification-passed", with: { verification_id: "offline-tests", inputs: ["src"] } });
  workflow.spec.nodes[0].gates[0].on_fail = "escalate";
  await server.sdlcs.publish("readonly-report", YAML.stringify(workflow));
}

async function submit_tests(run_id: string) {
  const context = await server.app.inject({ method: "GET", url: `/api/v1/requirements/REQ-REPORT/runs/${run_id}/nodes/review/verification-context` });
  expect(context.statusCode).toBe(200);
  const response = await server.app.inject({ method: "POST", url: `/api/v1/requirements/REQ-REPORT/runs/${run_id}/verifications`,
    headers: { "idempotency-key": ulid(), "content-type": "application/json" },
    payload: JSON.stringify({ run_id, node_id: "review", verification_id: "offline-tests", input_hash: context.json().verification.input_hash,
      command_hash: "a".repeat(64), status: "passed", exit_code: 0 }),
  });
  expect(response.statusCode).toBe(200);
}

describe("只读报告 server 闭环", () => {
  it("取消后新 run 复用原报告有明确任务来源，重启不重跑或重复复用", async () => {
    const first_run = await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT")).length === 1);
    const prior = (await server.sessions.readEvents("REQ-REPORT")).find((event) => event.type === "agent.task.completed")!;
    await server.runs.cancel(first_run.run_id);
    const second_run = await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT")).length === 1);
    const binding = await server.sdlcs.get("readonly-report", 1);
    const session = await server.sessions.open("REQ-REPORT");
    const observation = await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs);
    expect(observation.tasks[0]).toMatchObject({ status: "reused", run_id: second_run.run_id, completion_event_id: prior.event_id });
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
    const approval = (await server.sessions.listApprovals("REQ-REPORT"))[0]!;
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect((await server.sessions.listApprovals("REQ-REPORT"))[0]?.approval_id).toBe(approval.approval_id);
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.reused")).toHaveLength(1);
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
    expect((await readCoordinationExecutionContext(binding.def, await server.sessions.open("REQ-REPORT"), binding.workflow_revision, server.runs)).tasks[0]).toMatchObject({ status: "reused", completion_event_id: prior.event_id });
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    await server.runs.cancel(second_run.run_id);
    await server.sessions.writeDoc("REQ-REPORT", "prd", "# 新需求\nPRD 已变更，必须重新评审。");
    const third_run = await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT")).length === 1);
    const changed = await server.sessions.readEvents("REQ-REPORT");
    expect(changed.filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
    expect(changed.filter((event) => event.type === "agent.task.reused" && event.payload["run_id"] === third_run.run_id)).toHaveLength(0);
  });

  it("关闭 server 会收束旧 runner，保留原等待事实且不记用户取消", async () => {
    await bind_source();
    const run = await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "escalation");
    const prior = (await server.sessions.listApprovals("REQ-REPORT"))[0]!;
    await server.app.close();
    expect(server.runs.isActive("REQ-REPORT")).toBe(false);
    const events = await server.sessions.readEvents("REQ-REPORT");
    expect(events.filter((event) => event.type === "workflow.run.cancelled")).toHaveLength(0);
    expect(events.filter((event) => event.type === "human.decision.recorded")).toHaveLength(0);
    server.index.close();
    server = await buildApp({ root });
    expect((await server.sessions.listApprovals("REQ-REPORT"))[0]?.approval_id).toBe(prior.approval_id);
    expect((await server.runs.getRun(run.run_id)).status).toBe("waiting_human");
  });

  it.each([false, true])("源码绑定评审在重启后 changed=%s，只复用仍适用的报告", async (changed) => {
    await bind_source();
    const run = await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "escalation");
    await submit_tests(run.run_id);
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "human_confirm");
    const prior = (await server.sessions.listApprovals("REQ-REPORT"))[0]!;
    const first = (await server.sessions.readEvents("REQ-REPORT")).find((event) => event.type === "agent.task.completed")!;
    expect((first.payload as any).source_hash).toMatch(/^[0-9a-f]{64}$/);
    await server.app.close(); server.index.close();
    if (changed) await writeFile(join(root, "src", "draft.ts"), "export const version = 2;\n");
    server = await buildApp({ root });
    if (changed) {
      await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "escalation");
      const tasks = (await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed");
      expect(tasks).toHaveLength(2);
      expect((tasks[1]!.payload as any).source_hash).not.toBe((first.payload as any).source_hash);
      expect((tasks[1]!.payload as any).execution_input_hash).not.toBe((first.payload as any).execution_input_hash);
      const old = await server.app.inject({ method: "POST", url: `/api/v1/requirements/REQ-REPORT/approvals/${prior.approval_id}/decide`,
        headers: { "idempotency-key": ulid(), "content-type": "application/json" }, payload: JSON.stringify({ choice: "确认放行" }) });
      expect(old.statusCode).toBe(409);
      await submit_tests(run.run_id);
      await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "human_confirm");
    } else {
      expect((await server.sessions.listApprovals("REQ-REPORT"))[0]?.approval_id).toBe(prior.approval_id);
    }
    const approval = (await server.sessions.listApprovals("REQ-REPORT"))[0]!;
    await server.runs.decide("REQ-REPORT", approval.approval_id, "确认放行");
    await wait_for(async () => !server.runs.isActive("REQ-REPORT"));
    expect((await server.runs.getRun(run.run_id)).status).toBe("completed");
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed")).toHaveLength(changed ? 2 : 1);
  });

  it("真实只读 worker 运行期间代码变化阻断写回，恢复使用新的源码身份", async () => {
    await bind_source();
    await configure("# 实际报告\n\n## 结论\n等待核验。", 200);
    await server.agents.reload();
    const session = await server.sessions.open("REQ-REPORT");
    const before = await readFile(join(session.dir, "findings.md"), "utf8");
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    const unsubscribe = session.events.subscribe((event) => { if (event.type === "agent.task.started") notify(); });
    const failed = await start();
    await started;
    unsubscribe();
    await writeFile(join(root, "src", "draft.ts"), "export const version = 2;\n");
    await wait_for(async () => !server.runs.isActive("REQ-REPORT"));
    expect((await server.runs.getRun(failed.run_id)).status).toBe("failed");
    expect(await readFile(join(session.dir, "findings.md"), "utf8")).toBe(before);
    expect(await server.sessions.listApprovals("REQ-REPORT")).toEqual([]);
    const old = (await server.sessions.readEvents("REQ-REPORT")).find((event) => event.type === "agent.task.completed")!;
    expect(old.payload).toMatchObject({ status: "failed", failure_stage: "snapshot", artifact_written: false });
    await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT"))[0]?.kind === "escalation");
    const tasks = (await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed");
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.payload).toMatchObject({ status: "ok", written_by: "coordinator" });
    expect((tasks[1]!.payload as any).source_hash).not.toBe((old.payload as any).source_hash);
  });

  it("只读报告代写后形成新的人工审批，重启消费有效审批不重复 worker", async () => {
    await start(); await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT")).length === 1);
    const [first] = await server.sessions.listApprovals("REQ-REPORT");
    expect(await readFile(join(root, "cord", "REQ-REPORT", "findings.md"), "utf8")).toContain("## 结论");
    const events = await server.sessions.readEvents("REQ-REPORT");
    expect(events.find((event) => event.type === "agent.task.completed")?.payload).toMatchObject({ output: "text", artifact_written: true, written_by: "coordinator", agent_session_id: "thread-1" });
    expect(events.some((event) => event.type === "workflow.node.exited")).toBe(false);
    await server.app.close(); server.index.close(); server = await buildApp({ root });
    expect((await server.sessions.listApprovals("REQ-REPORT"))[0]?.approval_id).toBe(first!.approval_id);
    await server.runs.decide("REQ-REPORT", first!.approval_id, first!.options[0]!);
    await wait_for(async () => !server.runs.isActive("REQ-REPORT"));
    expect((await server.sessions.readEvents("REQ-REPORT")).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
    expect(server.runs.listRuns("REQ-REPORT")[0]?.status).toBe("completed");
  });
  it("空报告阻断任务，重载修复后可重新评审并生成报告", async () => {
    await configure(""); await server.agents.reload(); const failed = await start(); await wait_for(async () => !server.runs.isActive("REQ-REPORT"));
    expect((await server.runs.getRun(failed.run_id)).status).toBe("failed"); expect(await server.sessions.listApprovals("REQ-REPORT")).toEqual([]);
    expect(await readFile(join(root, "cord", "REQ-REPORT", "findings.md"), "utf8")).toContain("占位文档");
    await configure("# 恢复报告\n\n## 结论\n待人工"); await server.agents.reload(); await start();
    await wait_for(async () => (await server.sessions.listApprovals("REQ-REPORT")).length === 1);
    expect(await readFile(join(root, "cord", "REQ-REPORT", "findings.md"), "utf8")).toContain("恢复报告");
  });
});
