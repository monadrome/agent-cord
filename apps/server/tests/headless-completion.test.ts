import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/custom-mode-worker.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
const common = ["--model", "test-model", "--effort", "high", "--prompt", "{{prompt}}", "--readonly", "{{readonly}}"];
async function configure(scenario: "normal" | "first_fail" | "always_fail" | "observer_fail") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "headless", bin: process.execPath,
    args: [fixture, "--operation", "write", ...common, ...(scenario === "first_fail" ? ["--fail-first-exit"] : scenario === "always_fail" ? ["--exit-code", "3"] : [])],
    readonly_args: [fixture, "--operation", "review", ...common, ...(scenario === "observer_fail" ? ["--exit-code", "3"] : [])],
  } } }));
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("进程完成TCP验收超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const facts = () => server.sessions.readEvents("REQ-COMPLETION");
const calls = async () => (await readFile(join(root, ".mode-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function restart() {
  if (server) { await server.app.close(); server.index.close(); }
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
}
async function prepare(scenario: Parameters<typeof configure>[0], max_attempts = 2) {
  await configure(scenario); await restart();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "completion-http" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], max_attempts, review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8')!=='fixed')process.exit(1)"] }] } } },
    { id: "review", depends_on: ["deliver"], gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" },
      checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/completion-http/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-COMPLETION", title: "真实进程完成后交付", prd: "# PRD\nLATEST_COMPLETION_A：交付fixed代码与自测指南，最终人审。" })).status).toBe(201);
  return start();
}
async function start() {
  const response = await api("POST", "/requirements/REQ-COMPLETION/runs", { sdlc_id: "completion-http" }); expect(response.status).toBe(202); return response.body.run.run_id as string;
}
async function round() {
  const created = await api("POST", "/requirements/REQ-COMPLETION/coordination", { agent: "worker", sdlc_id: "completion-http" }); expect(created.status).toBe(202);
  const path = `/requirements/REQ-COMPLETION/coordination/${created.body.round.round_id}`;
  await wait(async () => ["ok", "failed", "timeout", "cancelled", "stale"].includes((await api("GET", path)).body.round.status)); return (await api("GET", path)).body.round;
}
beforeEach(async () => { server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-completion-tcp-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("真实进程完成TCP交付与最新协调", () => {
  it("首次候选晚失败自动重做，只有成功进程接受自测/就绪，cold人审不重复worker", async () => {
    const run_id = await prepare("first_fail"); await wait(async () => (await server.sessions.listApprovals("REQ-COMPLETION")).length === 1);
    const trace = await calls(); expect(trace).toHaveLength(2); expect(trace[1].prompt).toContain("code 3");
    const events = await facts(); const tasks = events.filter(event => event.type === "agent.task.completed");
    expect(tasks.map(event => event.payload["status"])).toEqual(["failed", "ok"]);
    expect(tasks[0]!.payload).toMatchObject({ failure_stage: "driver" }); expect(tasks[0]!.payload["artifact_written"] ?? false).toBe(false);
    expect(events.filter(event => event.type === "verification.completed")).toHaveLength(1);
    expect(events.find(event => event.type === "goal.attempt.completed" && event.payload["status"] === "ready")!.payload["attempt"]).toBe(2);
    expect((await api("GET", "/requirements/REQ-COMPLETION/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    const approval = (await server.sessions.listApprovals("REQ-COMPLETION"))[0]!;
    await restart(); expect(await calls()).toHaveLength(2); expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    expect((await server.sessions.listApprovals("REQ-COMPLETION"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect(events.filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("持续候选晚失败无自测/指南/人审，cold保留预算失败，修复配置后才能形成Draft", async () => {
    const run_id = await prepare("always_fail", 1); await wait(async () => !server.runs.isActive("REQ-COMPLETION"));
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toHaveLength(1);
    const before = await facts();
    expect(before.find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "driver" });
    expect(before.filter(event => event.type === "verification.completed" || event.type === "gate.waiting" || event.type === "workflow.node.exited")).toHaveLength(0);
    expect(before.find(event => event.type === "goal.attempt.completed")!.payload["status"]).toBe("blocked");
    await expect(readFile(join(root, "cord", "REQ-COMPLETION", "review.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await restart(); expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toHaveLength(1);
    await configure("normal"); await server.agents.reload(); await start(); await wait(async () => (await server.sessions.listApprovals("REQ-COMPLETION")).length === 1);
    expect(await calls()).toHaveLength(2); expect((await api("GET", "/requirements/REQ-COMPLETION/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("最新PRD协调候选晚失败不形成提议，冷保留失败；修复后新轮次基于B且不放行gate", async () => {
    await prepare("observer_fail"); await wait(async () => (await server.sessions.listApprovals("REQ-COMPLETION")).length === 1);
    expect((await api("PUT", "/requirements/REQ-COMPLETION/docs/prd", { content: "# PRD\nLATEST_COMPLETION_B：需求已更新，最终review未决。" })).status).toBe(200);
    const failed = await round(); expect(failed).toMatchObject({ status: "failed", proposal: null, current: null, adoptable: false });
    expect((await calls()).at(-1).prompt).toContain("LATEST_COMPLETION_B");
    const completed = (await facts()).find(event => event.type === "coordinator.round.completed")!;
    expect(completed.payload).toMatchObject({ status: "failed", failure_stage: "driver", proposal: null });
    await restart(); expect(await calls()).toHaveLength(2);
    expect((await api("GET", `/requirements/REQ-COMPLETION/coordination/${failed.round_id}`)).body.round).toMatchObject({ status: "failed", proposal: null });
    await configure("normal"); await server.agents.reload(); const fresh = await round();
    expect(fresh).toMatchObject({ status: "ok", current: true, proposal: { next_action: { kind: "wait" } } });
    expect((await calls()).at(-1).prompt).toContain("LATEST_COMPLETION_B");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "coordinator.round.adopted")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });
});
