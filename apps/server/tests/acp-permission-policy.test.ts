import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/acp-permission-worker.mjs", import.meta.url));
let root: string;
let server: BuiltServer | undefined;
let sequence = 0;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-acp-policy-server-"));
  await mkdir(join(root, "cord")); await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.txt"), "initial");
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });
async function api(method: "GET" | "POST", path: string, payload?: unknown) {
  const response = await server!.app.inject({ method, url: "/api/v1" + path,
    ...(method === "POST" ? { headers: { "idempotency-key": "acp-policy-" + sequence++ } } : {}), ...(payload === undefined ? {} : { payload }) });
  return { status: response.statusCode, body: response.json() };
}
async function waitFor(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() > deadline) throw Error("ACP 策略等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function events() { return (await server!.sessions.open("REQ-ACP-POLICY")).events.readOrdered(); }
async function calls() { return Number(await readFile(join(root, ".permission-worker-calls"), "utf8")); }
async function configure(edit: string[]) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "acp", bin: process.execPath, args: [fixture],
    permission_policy: { read: ["src"], edit }, env: { PRIVATE_ENV: "PRIVATE_POLICY_ENV" } } } }));
}
async function prepare(edit: string[], readonly = false, goal = true) {
  await configure(edit); server = await buildApp({ root });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "acp-policy" }, spec: { nodes: [{
    id: "deliver", artifact: "review.md", run: { agent: "worker", readonly,
      ...(goal ? { goal: { inputs: ["src"], max_attempts: 3, no_progress_limit: 2, timeout_ms: 20000,
        checks: [{ id: "value-test", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('src/value.txt','utf8') !== 'fixed') process.exit(1)"], timeout_ms: 2000 }] } }
        : readonly ? { output: "text" } : { retry: { max_attempts: 3, backoff_ms: 0 } }),
    }, gates: [{ id: "human-review", role: {}, attach: { node: "deliver", when: "post" },
      checks: goal ? [{ ref: "verification-passed", with: { verification_id: "value-test" } }] : [{ ref: "file-nonempty", with: { path: "review.md" } }],
      pass: { human_confirm: true }, on_fail: "block" }],
  }, { id: "done", depends_on: ["deliver"] }] } });
  expect((await api("POST", "/sdlcs/acp-policy/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-ACP-POLICY", title: "ACP 预授权", prd: "# Goal\n在声明工作区范围写 fixed，交付自测证据与 review 指南。" })).status).toBe(201);
  return start();
}
async function start() { const response = await api("POST", "/requirements/REQ-ACP-POLICY/runs", { sdlc_id: "acp-policy" }); expect(response.status).toBe(202); return response.body.run.run_id as string; }
async function approvals() { return (await api("GET", "/requirements/REQ-ACP-POLICY/approvals")).body.approvals; }

describe("ACP 预授权完整执行", () => {
  it("正常 read/edit Goal 无中途审批，实际通过后只等待最终人审，冷恢复不重调用", async () => {
    await prepare(["src"]); await waitFor(async () => (await approvals()).length === 1);
    expect(await calls()).toBe(1); expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("fixed");
    const facts = await events();
    expect(facts.filter(event => event.type === "goal.attempt.completed").at(-1)!.payload["status"]).toBe("ready");
    expect(facts.filter(event => event.type === "verification.completed").at(-1)!.payload["status"]).toBe("passed");
    expect(facts.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    expect(JSON.stringify(facts)).not.toContain("PRIVATE_PERMISSION"); expect(JSON.stringify(facts)).not.toContain("PRIVATE_POLICY_ENV");
    const original = (await approvals())[0].approval_id;
    await server!.app.close(); server!.index.close(); server = await buildApp({ root });
    expect(await calls()).toBe(1); expect((await approvals())[0].approval_id).toBe(original);
  });

  it("越界 edit 一次失败，策略修正后新 run 可恢复，旧配置 resolver 固定", async () => {
    const failed = await prepare(["src/private"]);
    await waitFor(async () => !server!.runs.isActive("REQ-ACP-POLICY") && (await server!.runs.getRun(failed)).status === "failed");
    expect(await calls()).toBe(1); expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("initial");
    expect((await events()).find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false });
    const before = server!.agents.resolver(); const old_hash = before("worker").configuration_hash;
    await configure(["src"]); expect((await api("POST", "/agents/reload")).status).toBe(200);
    expect(before("worker").configuration_hash).toBe(old_hash);
    expect(server!.agents.resolver()("worker").configuration_hash).not.toBe(old_hash);
    await start(); await waitFor(async () => (await approvals()).length === 1);
    expect(await calls()).toBe(2); expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("fixed");
  });

  it("人审期间策略身份改变后旧审批 409，剩余预算内重新检查新依据", async () => {
    await prepare(["src"]); await waitFor(async () => (await approvals()).length === 1);
    const previous = (await approvals())[0];
    await server!.app.close(); server!.index.close(); server = undefined;
    await configure(["src/value.txt"]); server = await buildApp({ root });
    expect((await api("POST", "/requirements/REQ-ACP-POLICY/approvals/" + previous.approval_id + "/decide", { choice: previous.options[0] })).status).toBe(409);
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await waitFor(async () => (await approvals()).some((item: any) => item.approval_id !== previous.approval_id));
    expect(await calls()).toBe(2);
  });

  it("readonly worker 不应用预授权，公开清单只显示数量与配置 hash", async () => {
    await prepare(["src/private"], true, false); await waitFor(async () => (await approvals()).length === 1);
    expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("initial");
    const entry = (await api("GET", "/agents")).body.agents.find((agent: any) => agent.name === "worker");
    expect(entry.permission_policy).toEqual({ read_count: 1, edit_count: 1 });
    expect(entry.configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("private"); expect(JSON.stringify(entry)).not.toContain("PRIVATE_POLICY_ENV");
  });

  it("普通 node.run.retry 不重复未获权限的 ACP 请求", async () => {
    const run_id = await prepare(["src/private"], false, false);
    await waitFor(async () => !server!.runs.isActive("REQ-ACP-POLICY") && (await server!.runs.getRun(run_id)).status === "failed");
    expect(await calls()).toBe(1); expect((await events()).filter(event => event.type === "agent.task.started")).toHaveLength(1);
  });
});
