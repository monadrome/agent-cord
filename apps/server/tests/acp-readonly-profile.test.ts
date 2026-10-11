import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient } from "../../console/src/api.js";

const worker_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const probe_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-acp-agent.mjs", import.meta.url));
const ids = { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" };
const launch = { provider: "anthropic", model: "large", effort: "high", mode: "code", option_ids: ids, config_options: { extended: true } };
const readonly_launch = { provider: "openai", model: "small", effort: "low", mode: "plan", option_ids: ids };
let root: string; let server: BuiltServer; let base: string;
async function configure(effort = "low", probe_mode?: string) {
  const args = probe_mode === undefined ? [worker_fixture, "--acp", "--launch-config", "--provider-config", "--profile-worker"]
    : [probe_fixture, "--config", "--config-mode", "--config-only", "--provider-option", "--no-tools", "--mode", probe_mode,
      "--record", join(root, "probe.jsonl"), "--gate-file", join(root, "release"), "--pid-file", join(root, "pid")];
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "acp", bin: process.execPath, args, launch, readonly_launch: { ...readonly_launch, effort } },
    headless: { kind: "headless", template: "claude", bin: "/missing/profile-cli" },
  } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>, message = "ACP只读配置等待超时") { const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const facts = () => server.sessions.readEvents("REQ-PROFILE");
const calls = async () => (await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const probes = async () => readFile(join(root, "probe.jsonl"), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line))).catch(() => []);
async function prepare() {
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "profile-delivery" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", depends_on: ["deliver"], artifact: "findings.md", run: { agent: "worker", readonly: true, output: "text" },
      gates: [{ id: "final-human", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/profile-delivery/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-PROFILE", title: "同ACP别名实现和只读协调", prd: "# PRD\nLATEST_PROFILE_A：修复业务值并交付人审指南" })).status).toBe(201);
}
async function start() { const result = await api("POST", "/requirements/REQ-PROFILE/runs", { sdlc_id: "profile-delivery" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-PROFILE/coordination", { agent: "worker", sdlc_id: "profile-delivery" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-PROFILE/coordination/${result.body.round.round_id}`;
  await wait(async () => (await api("GET", path)).body.round.status === "ok"); return (await api("GET", path)).body.round;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-acp-profile-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await configure(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("ACP只读配置HTTP交付与查询", () => {
  it("同别名Goal实现/宿主自测/只读报告/最新需求协调，冷等待不重复执行", async () => {
    await prepare(); const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-PROFILE")).length === 1);
    const rows = await calls(); expect(rows.map(row => row.configuration.workflow)).toEqual(["code", "code", "plan"]);
    expect(rows[2].configuration).toMatchObject({ provider: "openai", llm: "small", thinking: "low", extended: false });
    const original = (await server.sessions.listApprovals("REQ-PROFILE"))[0]!;
    expect((await api("GET", "/requirements/REQ-PROFILE/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    expect((await facts()).find(event => event.type === "agent.task.completed" && event.payload["node_id"] === "review")!.payload).toMatchObject({ artifact_written: true, written_by: "coordinator" });
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect(await calls()).toHaveLength(3); expect((await server.sessions.listApprovals("REQ-PROFILE"))[0]!.approval_id).toBe(original.approval_id);
    expect((await api("PUT", "/requirements/REQ-PROFILE/docs/prd", { content: "# PRD\nLATEST_PROFILE_B：保持最后人工gate" })).status).toBe(200);
    const round = await coordinate(); expect(round).toMatchObject({ current: true, proposal: { next_action: { kind: "wait" } } });
    expect((await calls()).at(-1)).toMatchObject({ configuration: { provider: "openai", llm: "small", workflow: "plan", extended: false } });
    expect((await calls()).at(-1).prompt).toContain("LATEST_PROFILE_B"); expect((await calls()).at(-1).prompt).toContain('"readonly_configuration":"explicit"');
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("只读配置热重载不改变在途resolver；独立协调使用新配置且旧提议失效", async () => {
    await prepare(); const session = await server.sessions.open("REQ-PROFILE"); const append = session.events.append.bind(session.events); let changed = false;
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await append(draft); if (!changed && draft.type === "agent.task.started") { changed = true; await configure("high"); } return event;
    });
    await start(); await wait(async () => (await server.sessions.listApprovals("REQ-PROFILE")).length === 1); spy.mockRestore();
    expect((await calls()).at(-1).configuration.thinking).toBe("low");
    const round = await coordinate(); expect((await calls()).at(-1).configuration.thinking).toBe("high");
    const worker_hash = round.agent_configuration_hash; await configure("low");
    expect(await server.coordination.get("REQ-PROFILE", round.round_id)).toMatchObject({ current: false });
    const fresh = await coordinate(); expect(fresh.agent_configuration_hash).not.toBe(worker_hash);
    expect((await calls()).at(-1).configuration.thinking).toBe("low");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("typed查询区分执行/只读候选，幂等重放保持任务模式并拒绝非法/非ACP查询", async () => {
    await configure("low", "mode-dependent-model"); const client = createClient(base);
    const writable = await client.inspectAgent("worker"); const key = ulid(); const readonly = await client.inspectAgent("worker", key, { readonly: true });
    expect(writable).not.toHaveProperty("readonly"); expect(readonly.readonly).toBe(true);
    expect(writable.observation!.config_options.find(option => option.id === "llm")?.values).toEqual(["small", "large"]);
    expect(readonly.observation!.config_options.find(option => option.id === "llm")?.values).toEqual(["small"]);
    const count = (await probes()).length; expect(await client.inspectAgent("worker", key, { readonly: true })).toEqual(readonly); expect(await probes()).toHaveLength(count);
    await expect(client.inspectAgent("worker", key)).rejects.toMatchObject({ status: 409 });
    expect(await api("POST", "/agents/headless/inspect", { readonly: true })).toMatchObject({ status: 200, body: { readonly: true, cli_observation: { status: "unavailable" } } });
    expect((await api("POST", "/agents/worker/inspect", { readonly: "true" })).status).toBe(400);
    expect((await probes()).some(row => row.event === "prompt")).toBe(false); expect(await server.sessions.listIds()).toEqual([]);
  });

  it("只读在途查询共享同模式、不同模式/重载冲突，关闭中取消进程", async () => {
    await configure("low", "gate-init"); const service = vi.spyOn(server.agents, "inspect");
    const first = api("POST", "/agents/worker/inspect", { readonly: true });
    await wait(async () => (await probes()).some(row => row.event === "initialize"));
    const second = api("POST", "/agents/worker/inspect", { readonly: true, timeout_ms: 5000 });
    await wait(async () => service.mock.calls.length === 2);
    expect((await api("POST", "/agents/worker/inspect", {})).status).toBe(409); expect((await probes()).filter(row => row.event === "initialize")).toHaveLength(1);
    await configure("high", "gate-init"); expect((await api("POST", "/agents/worker/inspect", { readonly: true })).status).toBe(409);
    await writeFile(join(root, "release"), "ready"); const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: 200, body: { readonly: true, current: false } }); expect(b.body.observation).toEqual(a.body.observation);
    expect((await probes()).find(row => row.configId === "thinking").value).toBe("low");
    expect((await api("POST", "/agents/worker/inspect", { readonly: true })).body).toMatchObject({ current: true });
    await configure("low", "hang-new"); const pending = api("POST", "/agents/worker/inspect", { readonly: true, timeout_ms: 10000 });
    await wait(async () => (await probes()).filter(row => row.event === "session/new").length === 3);
    const closing = server.agents.close(); expect(await pending).toMatchObject({ status: 503, body: { code: "service_closing" } }); await closing;
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    await wait(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, "只读查询进程未退出");
    expect((await probes()).some(row => row.event === "prompt")).toBe(false);
  });
});
