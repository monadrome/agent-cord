/** 只读报告经协调层代写后进入真实后置 gate，重启不会重复评审。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { ulid } from "ulid";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
let root: string; let server: BuiltServer;
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 10_000; while (!(await check())) { if (Date.now() > deadline) throw new Error("报告门禁观察超时"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
async function configure(text: string) {
  await mkdir(join(root, "cord"), { recursive: true }); await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { reviewer: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "codex-warning", "--result-text", text, "{{prompt}}"] } } }));
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

describe("只读报告 server 闭环", () => {
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
