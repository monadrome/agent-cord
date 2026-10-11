import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient } from "../../console/src/api.js";

const worker_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/custom-mode-worker.mjs", import.meta.url));
const cli_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/cli-inspection.mjs", import.meta.url));
const common = ["--model", "{{model}}", "--effort", "{{effort}}", "--prompt", "{{prompt}}", "--bare", "{{bare}}", "--auto", "{{auto}}",
  "--agent", "{{agent}}", "--agents-json", "{{agents_json}}", "--system-prompt", "{{system_prompt}}", "--max-turns", "{{max_turns}}", "--budget-usd", "{{budget_usd}}"];
let root: string; let server: BuiltServer; let base: string;
async function configure(role = "review-a", scenario = "normal") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath,
      args: [worker_fixture, "--operation", "write", "--readonly", "{{readonly}}", ...common],
      readonly_args: [worker_fixture, "--operation", "review", "--readonly", "{{readonly}}", ...common],
      launch: { model: "writer-model", effort: "high", bare: true, auto: true, agent: "writer", agents_json: '{"writer":{}}', system_prompt: "PRIVATE_WRITER_CONTEXT", max_turns: 8, budget_usd: 3 },
      readonly_launch: { model: "review-model", effort: "low", bare: true, auto: true, agent: role, agents_json: '{"reviewer":{}}', system_prompt: "PRIVATE_REVIEW_CONTEXT", max_turns: 2, budget_usd: 1 } },
    probe: { kind: "headless", template: "claude", bin: join(root, "cli.mjs"),
      launch: { model: "PRIVATE_WRITER_MODEL", bare: true, system_prompt: "PRIVATE_SYSTEM_PROMPT" }, readonly_launch: { effort: "low", agent: role },
      env: { CORD_INSPECT_PROFILE: "claude", CORD_INSPECT_SCENARIO: scenario, CORD_INSPECT_RECORD: join(root, "probes.jsonl"),
        CORD_INSPECT_GATE_FILE: join(root, "release"), CORD_INSPECT_PID_FILE: join(root, "pid") } },
  } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("Headless只读配置等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const facts = () => server.sessions.readEvents("REQ-HEADLESS-PROFILE");
const lines = async (file: string) => readFile(join(root, file), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line))).catch(() => []);
const calls = () => lines(".mode-calls.jsonl");
async function prepare() {
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "headless-profile" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", depends_on: ["deliver"], artifact: "review.md", run: { agent: "worker", readonly: true, require_readonly_mapping: true },
      gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/headless-profile/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-HEADLESS-PROFILE", title: "独立只读角色和模型", prd: "# PRD\nLATEST_PROFILE_A：实现并自测，最后人工review" })).status).toBe(201);
}
async function start() { const result = await api("POST", "/requirements/REQ-HEADLESS-PROFILE/runs", { sdlc_id: "headless-profile" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-HEADLESS-PROFILE/coordination", { agent: "worker", sdlc_id: "headless-profile" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-HEADLESS-PROFILE/coordination/${result.body.round.round_id}`;
  await wait(async () => (await api("GET", path)).body.round.status === "ok"); return (await api("GET", path)).body.round;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-headless-profile-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await copyFile(cli_fixture, join(root, "cli.mjs")); await chmod(join(root, "cli.mjs"), 0o755); await configure();
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("Headless独立profile TCP交付/查询", () => {
  it("Goal使用writer、评审/最新协调使用review模型资源，cold不重复有效worker，profile变化使旧提议失效", async () => {
    await prepare(); const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-HEADLESS-PROFILE")).length === 1);
    const initial = await calls(); expect(initial.map(call => [call.model, call.effort, call.launch_profile.agent, call.launch_profile.budget_usd])).toEqual([
      ["writer-model", "high", "writer", "3"], ["review-model", "low", "review-a", "1"],
    ]);
    expect(initial[1].launch_profile).toMatchObject({ max_turns: "2", auto: "false", system_prompt: "PRIVATE_REVIEW_CONTEXT" });
    const approval = (await server.sessions.listApprovals("REQ-HEADLESS-PROFILE"))[0]!;
    expect((await api("GET", "/requirements/REQ-HEADLESS-PROFILE/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect(await calls()).toHaveLength(2); expect((await server.sessions.listApprovals("REQ-HEADLESS-PROFILE"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    expect((await api("PUT", "/requirements/REQ-HEADLESS-PROFILE/docs/prd", { content: "# PRD\nLATEST_PROFILE_B：最新需求保留人工终审" })).status).toBe(200);
    const round = await coordinate(); expect(round.current).toBe(true); expect((await calls()).at(-1)).toMatchObject({ model: "review-model", launch_profile: { agent: "review-a", auto: "false" } });
    expect((await calls()).at(-1).prompt).toContain("LATEST_PROFILE_B");
    await configure("review-b"); expect(await server.coordination.get("REQ-HEADLESS-PROFILE", round.round_id)).toMatchObject({ current: false });
    const fresh = await coordinate(); expect(fresh.current).toBe(true); expect(fresh.agent_configuration_hash).not.toBe(round.agent_configuration_hash);
    expect((await calls()).at(-1).launch_profile.agent).toBe("review-b");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("readonly配置在途保持原resolver，新协调使用重载后角色", async () => {
    await prepare(); const session = await server.sessions.open("REQ-HEADLESS-PROFILE"); const append = session.events.append.bind(session.events); let changed = false;
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await append(draft); if (!changed && draft.type === "agent.task.started") { changed = true; await configure("review-b"); } return result;
    });
    await start(); await wait(async () => (await server.sessions.listApprovals("REQ-HEADLESS-PROFILE")).length === 1); spy.mockRestore();
    expect((await calls()).at(-1).launch_profile.agent).toBe("review-a"); await coordinate(); expect((await calls()).at(-1).launch_profile.agent).toBe("review-b");
  });

  it("typed CLI帮助查询按所选配置投影，幂等保留模式、只用help且原始args只读查询拒绝", async () => {
    const client = createClient(base); const writable = await client.inspectAgent("probe"); const key = ulid(); const readonly = await client.inspectAgent("probe", key, { readonly: true });
    expect(writable).not.toHaveProperty("readonly"); expect(readonly).toMatchObject({ readonly: true, observation: null, cli_observation: { status: "passed" } });
    const options = readonly.cli_observation!.launch_options;
    expect(options.find(option => option.id === "model")).toMatchObject({ configured: false, advertised: true });
    expect(options.find(option => option.id === "effort")).toMatchObject({ configured: true, advertised: true });
    expect(writable.cli_observation!.launch_options.find(option => option.id === "model")!.configured).toBe(true);
    expect((await lines("probes.jsonl")).map(row => row.args)).toEqual([["--version"], ["--help"], ["--version"], ["--help"]]);
    expect(JSON.stringify(readonly)).not.toContain("PRIVATE_");
    expect(await client.inspectAgent("probe", key, { readonly: true })).toEqual(readonly); expect(await lines("probes.jsonl")).toHaveLength(4);
    await expect(client.inspectAgent("probe", key)).rejects.toMatchObject({ status: 409 });
    await expect(client.inspectAgent("worker", undefined, { readonly: true })).rejects.toMatchObject({ status: 400 });
    await expect(readFile(join(root, ".mode-calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同readonly模式共享probe，执行模式/新配置冲突；旧结果过期后重查新配置", async () => {
    await configure("review-a", "gate-version"); const service = vi.spyOn(server.agents, "inspect");
    const first = api("POST", "/agents/probe/inspect", { readonly: true }); await wait(async () => (await lines("probes.jsonl")).length === 1);
    const second = api("POST", "/agents/probe/inspect", { readonly: true, timeout_ms: 5000 }); await wait(async () => service.mock.calls.length === 2);
    expect((await api("POST", "/agents/probe/inspect", {})).status).toBe(409);
    await configure("review-b"); expect((await api("POST", "/agents/probe/inspect", { readonly: true })).status).toBe(409);
    await writeFile(join(root, "release"), "ready"); const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: 200, body: { readonly: true, current: false } }); expect(b.body.cli_observation).toEqual(a.body.cli_observation);
    expect(await lines("probes.jsonl")).toHaveLength(2); expect((await api("POST", "/agents/probe/inspect", { readonly: true })).body.current).toBe(true);
    expect(await lines("probes.jsonl")).toHaveLength(4);
  });

  it("服务关闭取消只读help查询并清理进程，不继续后续步骤或调用模型", async () => {
    await configure("review-a", "hang-help"); const pending = api("POST", "/agents/probe/inspect", { readonly: true, timeout_ms: 10000 });
    await wait(async () => (await lines("probes.jsonl")).some(row => row.args[0] === "--help"));
    const closing = server.agents.close(); expect(await pending).toMatchObject({ status: 503, body: { code: "service_closing" } }); await closing;
    const pid = Number(await readFile(join(root, "pid"), "utf8")); await wait(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect((await lines("probes.jsonl")).map(row => row.args)).toEqual([["--version"], ["--help"]]);
    await expect(readFile(join(root, ".mode-calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
