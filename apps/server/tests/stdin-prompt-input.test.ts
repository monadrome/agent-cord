import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/stdin-prompt-worker.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
async function configure(kind: "template" | "custom", model = "review-model") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "headless",
    ...(kind === "template" ? { template: "codex", bin: join(root, "stdin-cli.mjs"), env: { CORD_STDIN_OPERATION: "workflow" } } : {
      bin: process.execPath, prompt_input: "stdin", args: [fixture, "--operation", "workflow", "--model", "{{model}}", "--effort", "{{effort}}", "--readonly", "{{readonly}}", "-"],
    }), launch: { model: "writer-model", effort: "high" }, readonly_launch: { model, effort: "low" },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("stdin Prompt TCP验收超时"); await new Promise(resolve => setTimeout(resolve, 15));
} }
const calls = async () => (await readFile(join(root, ".stdin-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const facts = () => server.sessions.readEvents("REQ-STDIN");
async function restart() {
  if (server) { await server.app.close(); server.index.close(); }
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
}
async function prepare(kind: Parameters<typeof configure>[0]) {
  await configure(kind); await restart();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "stdin-workflow" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8')!=='fixed')process.exit(1)"] }] } } },
    { id: "review", artifact: "review.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, require_readonly_mapping: true },
      gates: [{ id: "human", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/stdin-workflow/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-STDIN", title: "标准输入交付与协调", prd: "# PRD\nPRIVATE_STDIN_A：中文多行原文。\n--help\n-\nresume\n$(literal) {{model}}" })).status).toBe(201);
}
async function start() { const result = await api("POST", "/requirements/REQ-STDIN/runs", { sdlc_id: "stdin-workflow" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function round() {
  const created = await api("POST", "/requirements/REQ-STDIN/coordination", { agent: "worker", sdlc_id: "stdin-workflow" }); expect(created.status).toBe(202);
  const path = `/requirements/REQ-STDIN/coordination/${created.body.round.round_id}`;
  await wait(async () => ["ok", "failed", "timeout", "cancelled", "stale"].includes((await api("GET", path)).body.round.status)); return (await api("GET", path)).body.round;
}
beforeEach(async () => { server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-stdin-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); await copyFile(fixture, join(root, "stdin-cli.mjs")); await chmod(join(root, "stdin-cli.mjs"), 0o755); });
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("stdin任务实际TCP交付/最新快照/恢复", () => {
  it.each(["template", "custom"] as const)("%s Goal/readonly/协调使用完整stdin，两套profile独立，cold不重做，重载使旧提议失效", async kind => {
    await prepare(kind); const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-STDIN")).length === 1);
    const initial = await calls(); expect(initial.map(call => [call.readonly, call.model])).toEqual([[false, "writer-model"], [true, "review-model"]]);
    for (const call of initial) { expect(call.prompt).toContain("PRIVATE_STDIN_A"); expect(call.args.join("\n")).not.toContain("PRIVATE_STDIN_A"); expect(call.input_hex).toBe(Buffer.from(call.prompt, "utf8").toString("hex")); }
    const guide = (await api("GET", "/requirements/REQ-STDIN/artifacts?path=review.md")).body.content; expect(guide).toContain("宿主验证证据");
    const approval = (await server.sessions.listApprovals("REQ-STDIN"))[0]!;
    await restart(); expect(await calls()).toHaveLength(2); expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    expect((await server.sessions.listApprovals("REQ-STDIN"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await api("PUT", "/requirements/REQ-STDIN/docs/prd", { content: "# PRD\nPRIVATE_STDIN_B：最新尾部仍须最终人审。\n--help\n-\nresume" })).status).toBe(200);
    const current = await round(); expect(current).toMatchObject({ status: "ok", current: true, proposal: { next_action: { kind: "wait" } } });
    const coordinator = (await calls()).at(-1); expect(coordinator).toMatchObject({ readonly: true, model: "review-model" }); expect(coordinator.prompt).toContain("PRIVATE_STDIN_B");
    expect(coordinator.args.join("\n")).not.toContain("PRIVATE_STDIN_B"); expect(coordinator.prompt).toContain('"prompt_input":"stdin"');
    await configure(kind, "review-new"); expect(await server.coordination.get("REQ-STDIN", current.round_id)).toMatchObject({ current: false });
    expect(await round()).toMatchObject({ status: "ok", current: true }); expect((await calls()).at(-1).model).toBe("review-new");
    expect((await api("GET", "/requirements/REQ-STDIN/artifacts?path=review.md")).body.content).toBe(guide);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "coordinator.round.adopted")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("stdin查询无任务原文且幂等，无效声明修复后才可注册/执行", async () => {
    await configure("template"); await restart(); const key = ulid(); const inspected = await api("POST", "/agents/worker/inspect", { readonly: true }, key);
    expect(inspected).toMatchObject({ status: 200, body: { capabilities: { prompt_input: "stdin" }, cli_observation: { status: "passed" } } });
    expect((await api("POST", "/agents/worker/inspect", { readonly: true }, key)).body).toEqual(inspected.body);
    const probes = (await readFile(join(root, ".stdin-probes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(probes.map(probe => probe.args)).toEqual([["--version"], ["exec", "--help"], ["exec", "resume", "--help"]]); expect(probes.every(probe => probe.input_hex === "")).toBe(true);
    await expect(readFile(join(root, ".stdin-calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { codex: { kind: "headless", bin: process.execPath, args: [fixture, "{{prompt}}"], prompt_input: "stdin" } } }));
    const invalid = await server.agents.reload(); expect(invalid.rejected).toContain("codex"); expect(() => server.agents.resolver()("codex")).toThrow(/配置无效/);
    await configure("custom"); expect(server.agents.catalog().agents.find(agent => agent.name === "worker")!.capabilities).toMatchObject({ prompt_input: "stdin" });
  });

  it("在途stdin profile保持原resolver，后续协调才使用重载后的readonly模型", async () => {
    await prepare("custom"); const session = await server.sessions.open("REQ-STDIN"); const append = session.events.append.bind(session.events); let changed = false;
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await append(draft); if (!changed && draft.type === "agent.task.started") { changed = true; await configure("custom", "review-new"); } return event;
    });
    await start(); await wait(async () => (await server.sessions.listApprovals("REQ-STDIN")).length === 1); spy.mockRestore();
    expect((await calls()).at(-1).model).toBe("review-model"); expect(await round()).toMatchObject({ status: "ok", current: true }); expect((await calls()).at(-1).model).toBe("review-new");
  });
});
