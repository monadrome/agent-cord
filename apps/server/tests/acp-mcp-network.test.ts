import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { start_mcp_network_fixture } from "../../../tests/driver/fixtures/mcp-network-server.mjs";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/acp-mcp-worker.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string; let remote: Awaited<ReturnType<typeof start_mcp_network_fixture>>;
async function configure(type: "http" | "sse", token = "LOCAL_MCP_TOKEN") {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "acp", bin: process.execPath,
    args: [worker, "--network-transports", "--record", join(root, "worker.jsonl")], launch: { mode: "code", option_ids: { mode: "workflow" } },
    readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } },
    mcp_servers: [{ type, name: "network-source", url: remote.url, headers_from: { Authorization: "CORD_NETWORK_MCP_AUTH" } }], env: { CORD_NETWORK_MCP_AUTH: token },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean> | boolean) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("网络MCP SDLC等待超时"); await new Promise(resolve => setTimeout(resolve, 20));
} }
const calls = async () => readFile(join(root, "worker.jsonl"), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line))).catch(() => []);
const facts = () => server.sessions.readEvents("REQ-NETWORK-MCP");
async function prepare(type: "http" | "sse", token?: string) {
  remote = await start_mcp_network_fixture({ type }); await configure(type, token); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "network-mcp" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "business-value", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text" },
      gates: [{ id: "final-human", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/network-mcp/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-NETWORK-MCP", title: "网络MCP自主交付", prd: "# PRD\nLATEST_NETWORK_A：用工具值修复业务并交付当前自测" })).status).toBe(201);
}
async function start() { const result = await api("POST", "/requirements/REQ-NETWORK-MCP/runs", { sdlc_id: "network-mcp" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
beforeEach(async () => { server = undefined as unknown as BuiltServer; remote = undefined as unknown as typeof remote;
  root = await mkdtemp(join(tmpdir(), "cord-network-mcp-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } if (remote) await remote.close(); await rm(root, { recursive: true, force: true }); });

describe("HTTP/SSE网络MCP TCP交付", () => {
  it.each(["http", "sse"] as const)("%s实际认证/工具与宿主自测，readonly/最新快照不连接，冷等待不重放", async type => {
    await prepare(type);
    expect((await api("POST", "/agents/worker/inspect", {})).body.observation.mcp_transports).toMatchObject({ http: true, sse: true, connections: "not_requested" });
    expect(remote.metrics.requests).toBe(0);
    const run_id = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-NETWORK-MCP")).length === 1);
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human"); expect(remote.metrics.tool_calls).toBe(1);
    await wait(() => remote.metrics.active_requests === 0 && remote.active_sessions() === 0);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect((await api("GET", "/requirements/REQ-NETWORK-MCP/artifacts?path=review.md")).body.content).toContain("宿主验证证据");
    expect((await calls()).filter(call => call.event === "prompt").map(call => [call.mode, call.connections])).toEqual([["code", 1], ["plan", 0]]);
    const approval = (await server.sessions.listApprovals("REQ-NETWORK-MCP"))[0]!; const count = remote.metrics.requests;
    await server.app.close(); server.index.close(); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
    expect(remote.metrics.requests).toBe(count); expect((await server.sessions.listApprovals("REQ-NETWORK-MCP"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await api("PUT", "/requirements/REQ-NETWORK-MCP/docs/prd", { content: "# PRD\nLATEST_NETWORK_B：更新需求保持最终人工review" })).status).toBe(200);
    const created = await api("POST", "/requirements/REQ-NETWORK-MCP/coordination", { agent: "worker", sdlc_id: "network-mcp" }); expect(created.status).toBe(202);
    const path = `/requirements/REQ-NETWORK-MCP/coordination/${created.body.round.round_id}`;
    await wait(async () => (await api("GET", path)).body.round.status === "ok"); expect((await api("GET", path)).body.round.current).toBe(true);
    expect((await calls()).filter(call => call.event === "prompt").at(-1)).toMatchObject({ mode: "plan", connections: 0 });
    expect((await calls()).filter(call => call.event === "prompt").at(-1).prompt).toContain("LATEST_NETWORK_B");
    expect(remote.metrics.requests).toBe(count); expect(remote.metrics.tool_calls).toBe(1);
    const history = await facts(); expect(JSON.stringify(history)).not.toContain("LOCAL_MCP_TOKEN");
    expect(history.filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect(history.filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it.each(["http", "sse"] as const)("%s认证失败形成非重试卡点，修复凭据后新run交付", async type => {
    await prepare(type, "PRIVATE_WRONG_TOKEN"); const failed = await start(); await wait(async () => !server.runs.isActive("REQ-NETWORK-MCP"));
    expect((await server.runs.getRun(failed)).status).toBe("failed"); expect(remote.metrics.tool_calls).toBe(0);
    const before = await facts(); expect(before.find(event => event.type === "agent.task.completed")!.payload).toMatchObject({ failure_stage: "driver", retryable: false });
    expect(before.filter(event => event.type === "verification.completed" || event.type === "gate.waiting")).toHaveLength(0);
    expect(JSON.stringify(before)).not.toContain("PRIVATE_WRONG_TOKEN");
    const hash = server.agents.resolver()("worker").configuration_hash;
    await configure(type); expect(server.agents.resolver()("worker").configuration_hash).toBe(hash);
    const repaired = await start(); await wait(async () => (await server.sessions.listApprovals("REQ-NETWORK-MCP")).length === 1);
    expect((await server.runs.getRun(repaired)).status).toBe("waiting_human"); expect(remote.metrics.tool_calls).toBe(1);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
