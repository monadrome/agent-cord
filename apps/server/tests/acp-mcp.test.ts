import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/acp-mcp-worker.mjs", import.meta.url));
const mcp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/mcp-value-server.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
async function configure(revision = "A", http = false) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "acp", bin: process.execPath,
    args: [acp_fixture, "--record", join(root, "worker.jsonl")], launch: { mode: "code", option_ids: { mode: "workflow" } }, readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } },
    mcp_servers: http ? [{ type: "http", name: "unsupported", url: "http://127.0.0.1:1/mcp" }] : [{ type: "stdio", name: "private-tool-name", command: process.execPath,
      args: [mcp_fixture, "--record", join(root, "mcp.jsonl"), "--pid-file", join(root, "mcp.pid"), "--revision", revision], env_from: { FIXTURE_VALUE: "CORD_MCP_VALUE" } }],
    env: { CORD_MCP_VALUE: "fixed", CORD_MCP_PRIVATE: "PRIVATE_MCP_VALUE" },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key = ulid()) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": key }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("MCP SDLC验收等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const lines = async (file: string) => readFile(join(root, file), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line))).catch(() => []);
const facts = () => server.sessions.readEvents("REQ-MCP");
async function start() { const result = await api("POST", "/requirements/REQ-MCP/runs", { sdlc_id: "mcp-delivery" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
async function coordinate() {
  const result = await api("POST", "/requirements/REQ-MCP/coordination", { agent: "worker", sdlc_id: "mcp-delivery" }); expect(result.status).toBe(202);
  const path = `/requirements/REQ-MCP/coordination/${result.body.round.round_id}`;
  await wait(async () => (await api("GET", path)).body.round.status === "ok"); return (await api("GET", path)).body.round;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-mcp-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  await configure(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "mcp-delivery" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", depends_on: ["deliver"], artifact: "findings.md", run: { agent: "worker", readonly: true, output: "text" },
      gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/mcp-delivery/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-MCP", title: "MCP工具自主交付", prd: "# PRD\nLATEST_MCP_A：读取MCP工具业务值并交付宿主自测/指南" })).status).toBe(201);
});
afterEach(async () => { vi.restoreAllMocks(); if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("ACP MCP真实工具与TCP SDLC", () => {
  it("查询不spawn MCP，实际工具结果/宿主检查/只读报告与最新快照协调，人审及冷恢复保持", async () => {
    const key = ulid(); const inspection = await api("POST", "/agents/worker/inspect", {}, key); expect(inspection.status).toBe(200);
    expect(inspection.body.observation.mcp_transports).toEqual({ stdio: "required", http: false, sse: false, connections: "not_requested" });
    expect(await lines("mcp.jsonl")).toEqual([]); expect((await lines("worker.jsonl")).some(row => row.event === "prompt")).toBe(false);
    const count = (await lines("worker.jsonl")).length; expect((await api("POST", "/agents/worker/inspect", {}, key)).body).toEqual(inspection.body);
    expect(await lines("worker.jsonl")).toHaveLength(count);
    const catalog = (await api("GET", "/agents")).body;
    expect(catalog.agents.find((agent: { name: string }) => agent.name === "worker").capabilities.mcp_configuration).toEqual({ writable_count: 1, readonly_count: 0, transports: ["stdio"] });
    for (const text of [JSON.stringify(catalog), JSON.stringify(inspection.body)]) {
      expect(text).not.toContain("PRIVATE_MCP_VALUE"); expect(text).not.toContain("private-tool-name"); expect(text).not.toContain("CORD_MCP_VALUE"); expect(text).not.toContain(root);
    }
    const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-MCP")).length === 1);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect((await lines("mcp.jsonl")).map(row => row.event)).toEqual(["started", "tool.called"]);
    expect((await lines("worker.jsonl")).filter(row => row.event === "prompt").map(row => [row.mode, row.connections])).toEqual([["code", 1], ["plan", 0]]);
    expect((await api("GET", "/requirements/REQ-MCP/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human"); const approval = (await server.sessions.listApprovals("REQ-MCP"))[0]!;
    const pid = Number(await readFile(join(root, "mcp.pid"), "utf8")); expect(() => process.kill(pid, 0)).toThrow();
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect((await server.sessions.listApprovals("REQ-MCP"))[0]!.approval_id).toBe(approval.approval_id); expect(await lines("mcp.jsonl")).toHaveLength(2);
    expect((await api("PUT", "/requirements/REQ-MCP/docs/prd", { content: "# PRD\nLATEST_MCP_B：当前需求保持人工终审" })).status).toBe(200);
    const round = await coordinate(); expect(round).toMatchObject({ current: true, proposal: { next_action: { kind: "wait" } } });
    const prompt = (await lines("worker.jsonl")).filter(row => row.event === "prompt").at(-1)!;
    expect(prompt).toMatchObject({ mode: "plan", connections: 0 }); expect(prompt.prompt).toContain("LATEST_MCP_B"); expect(prompt.prompt).toContain('"mcp_configuration"');
    expect(prompt.prompt).not.toContain("private-tool-name"); expect(prompt.prompt).not.toContain("PRIVATE_MCP_VALUE"); expect(await lines("mcp.jsonl")).toHaveLength(2);
    expect(JSON.stringify(await facts())).not.toContain("PRIVATE_MCP_VALUE");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("未协商HTTP形成不可重试driver卡点，无MCP/自测/人审，修复后重新交付", async () => {
    await configure("A", true); const run_id = await start(); await wait(async () => !server.runs.isActive("REQ-MCP"));
    expect((await server.runs.getRun(run_id)).status).toBe("failed");
    const before = await facts(); expect(before.find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false });
    expect(before.filter(event => event.type === "verification.completed" || event.type === "gate.waiting")).toHaveLength(0); expect(await lines("mcp.jsonl")).toEqual([]);
    expect(await lines("worker.jsonl")).toEqual([]);
    await configure(); await start(); await wait(async () => (await server.sessions.listApprovals("REQ-MCP")).length === 1);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed"); expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("MCP变更不污染在途resolver，最新协调绑定新配置、旧提议失效", async () => {
    const session = await server.sessions.open("REQ-MCP"); const append = session.events.append.bind(session.events); let reloaded = false;
    const spy = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      const event = await append(draft); if (!reloaded && draft.type === "agent.task.started") { reloaded = true; await configure("B"); } return event;
    });
    await start(); await wait(async () => (await server.sessions.listApprovals("REQ-MCP")).length === 1); spy.mockRestore();
    expect((await lines("mcp.jsonl"))[0]).toMatchObject({ revision: "A" });
    const round = await coordinate(); expect(round.current).toBe(true); await configure("C");
    expect(await server.coordination.get("REQ-MCP", round.round_id)).toMatchObject({ current: false });
    const next = await coordinate(); expect(next.current).toBe(true); expect(next.agent_context_hash).not.toBe(round.agent_context_hash);
    expect(await lines("mcp.jsonl")).toHaveLength(2); expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
