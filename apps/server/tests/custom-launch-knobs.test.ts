import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/custom-mode-worker.mjs", import.meta.url));
const common = ["--model", "{{model}}", "--effort", "{{effort}}", "--prompt", "{{prompt}}", "--bare", "{{bare}}", "--auto", "{{auto}}",
  "--agent", "{{agent}}", "--agents-json", "{{agents_json}}", "--system-prompt", "{{system_prompt}}", "--max-turns", "{{max_turns}}", "--budget-usd", "{{budget_usd}}"];
let root: string; let server: BuiltServer; let base: string;
async function configure(role = "architect-a", invalid = false) {
  const readonly_args = [fixture, "--operation", "review", "--readonly", "{{readonly}}", ...common];
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { wrapper: { kind: "headless", bin: process.execPath,
    args: [fixture, "--operation", "write", "--readonly", "{{readonly}}", ...common],
    readonly_args: invalid ? readonly_args.filter(value => value !== "{{agent}}") : readonly_args,
    resume_args: [fixture, "--session", "{{resume_session_id}}", "--operation", "write", "--readonly", "{{readonly}}", ...common],
    readonly_resume_args: [fixture, "--session", "{{resume_session_id}}", "--operation", "review", "--readonly", "{{readonly}}", ...common],
    launch: { model: "fixture-model", effort: "high", bare: true, auto: true, agent: role, agents_json: '{"role":{"prompt":"PRIVATE_ROLE_JSON {{auto}}"}}',
      system_prompt: "PRIVATE_ROLE_SYSTEM `literal`", max_turns: 7, budget_usd: 2.5 },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("自定义完整旋钮验收等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const facts = () => server.sessions.readEvents("REQ-KNOBS");
const calls = async () => (await readFile(join(root, ".mode-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function start() { const result = await api("POST", "/requirements/REQ-KNOBS/runs", { sdlc_id: "wrapper-knobs" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-KNOBS/coordination", { agent: "wrapper", sdlc_id: "wrapper-knobs" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-KNOBS/coordination/${result.body.round.round_id}`;
  await wait(async () => (await api("GET", path)).body.round.status === "ok"); return (await api("GET", path)).body.round;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-wrapper-knobs-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await configure(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "wrapper-knobs" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "wrapper", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", depends_on: ["deliver"], artifact: "review.md", run: { agent: "wrapper", readonly: true, require_readonly_mapping: true },
      gates: [{ id: "final-human", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/wrapper-knobs/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-KNOBS", title: "Wrapper完整启动控制", prd: "# PRD\nLATEST_KNOB_A：修复业务值并交付自测/指南" })).status).toBe(201);
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("自定义完整旋钮TCP Goal", () => {
  it("bare/角色/资源实际传入，readonly auto=false；cold不重做、最新协调与角色变更绑定身份", async () => {
    const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-KNOBS")).length === 1);
    expect((await calls()).map(call => [call.action, call.launch_profile.auto])).toEqual([["write", "true"], ["review", "false"]]);
    for (const call of await calls()) expect(call.launch_profile).toMatchObject({ bare: "true", max_turns: "7", budget_usd: "2.5", agent: "architect-a",
      agents_json: '{"role":{"prompt":"PRIVATE_ROLE_JSON {{auto}}"}}', system_prompt: "PRIVATE_ROLE_SYSTEM `literal`" });
    const guide = (await api("GET", "/requirements/REQ-KNOBS/artifacts?path=review.md")).body.content; expect(guide).toContain("宿主验证证据");
    const approval = (await server.sessions.listApprovals("REQ-KNOBS"))[0]!;
    const catalog = (await api("GET", "/agents")).body;
    expect(catalog.agents.find((agent: { name: string }) => agent.name === "wrapper").capabilities.launch_options).toEqual([
      "model", "effort", "max_turns", "budget_usd", "system_prompt", "agent", "agents_json", "bare", "auto",
    ]);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE_ROLE");
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect(await calls()).toHaveLength(2); expect((await server.sessions.listApprovals("REQ-KNOBS"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    expect((await api("PUT", "/requirements/REQ-KNOBS/docs/prd", { content: "# PRD\nLATEST_KNOB_B：最新需求保留最终人工gate" })).status).toBe(200);
    const round = await coordinate(); expect(round.current).toBe(true);
    expect((await calls()).at(-1)).toMatchObject({ action: "review", launch_profile: { auto: "false" } }); expect((await calls()).at(-1).prompt).toContain("LATEST_KNOB_B");
    expect((await api("GET", "/requirements/REQ-KNOBS/artifacts?path=review.md")).body.content).toBe(guide);
    await configure("architect-b"); expect(await server.coordination.get("REQ-KNOBS", round.round_id)).toMatchObject({ current: false });
    const fresh = await coordinate(); expect(fresh.current).toBe(true); expect(fresh.agent_configuration_hash).not.toBe(round.agent_configuration_hash);
    expect((await calls()).at(-1).launch_profile).toMatchObject({ agent: "architect-b", auto: "false" });
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("在途snapshot继续使用原角色，最新协调读取重载后定义", async () => {
    const session = await server.sessions.open("REQ-KNOBS"); const append = session.events.append.bind(session.events); let changed = false;
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const result = await append(draft); if (!changed && draft.type === "agent.task.started") { changed = true; await configure("architect-b"); } return result;
    });
    await start(); await wait(async () => (await server.sessions.listApprovals("REQ-KNOBS")).length === 1); spy.mockRestore();
    expect((await calls()).map(call => call.launch_profile.agent)).toEqual(["architect-a", "architect-a"]);
    await coordinate(); expect((await calls()).at(-1).launch_profile.agent).toBe("architect-b");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("漏角色分支拒绝别名，Goal无进程/自测/人审；修复后可重新交付", async () => {
    await configure("architect-a", true); const failed = await start(); await wait(async () => !server.runs.isActive("REQ-KNOBS"));
    expect((await server.runs.getRun(failed)).status).toBe("failed");
    await expect(readFile(join(root, ".mode-calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await api("GET", "/agents")).body.rejected).toContain("wrapper");
    expect((await facts()).filter(event => event.type === "agent.task.started" || event.type === "agent.task.completed")).toHaveLength(0);
    expect((await facts()).find(event => event.type === "goal.attempt.completed")!.payload).toMatchObject({ status: "blocked", reason: "无法读取 Goal 的当前需求、源码或配置身份" });
    expect((await facts()).filter(event => event.type === "verification.completed" || event.type === "gate.waiting")).toHaveLength(0);
    await configure(); await start(); await wait(async () => (await server.sessions.listApprovals("REQ-KNOBS")).length === 1);
    expect((await calls()).map(call => call.launch_profile.auto)).toEqual(["true", "false"]);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
