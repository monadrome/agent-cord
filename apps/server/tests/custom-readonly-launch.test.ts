import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { sha256Hex } from "agent-cord";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/custom-mode-worker.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
const common = ["--model", "{{model}}", "--effort", "{{effort}}", "--prompt", "{{prompt}}"];
async function configure(bad = false) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { wrapper: { kind: "headless", bin: process.execPath,
    args: [fixture, "--operation", "write", "--readonly", "{{readonly}}", ...common],
    readonly_args: [fixture, "--operation", "review", "--readonly", "{{readonly}}", ...common, ...(bad ? ["--emit-write-tool"] : [])],
    resume_args: [fixture, "--session", "{{resume_session_id}}", "--operation", "write", "--readonly", "{{readonly}}", ...common],
    readonly_resume_args: [fixture, "--session", "{{resume_session_id}}", "--operation", "review", "--readonly", "{{readonly}}", ...common],
    launch: { model: "fixture-model", effort: "high" },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }), ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() >= deadline) throw new Error("自定义wrapper等待超时"); await new Promise(resolve => setTimeout(resolve, 15)); } }
const facts = async () => server.sessions.readEvents("REQ-MODES");
const calls = async () => (await readFile(join(root, ".mode-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function prepare(bad = false) {
  await configure(bad);
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "custom-modes" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "wrapper", goal: { inputs: ["value.txt"], review_changes: true, max_attempts: 3,
      checks: [{ id: "value-check", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8') !== 'fixed')process.exit(1)"] }] } } },
    { id: "review", artifact: "review.md", depends_on: ["deliver"], run: { agent: "wrapper", readonly: true, retry: { max_attempts: 3, backoff_ms: 0 } },
      gates: [{ id: "final-human", attach: { node: "review", when: "post" }, role: {}, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/custom-modes/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-MODES", title: "自定义实现与只读评审", prd: "# PRD\nLATEST_MODE_REQUIREMENT" })).status).toBe(201);
  const result = await api("POST", "/requirements/REQ-MODES/runs", { sdlc_id: "custom-modes" }); expect(result.status).toBe(202); return result.body.run.run_id as string;
}
beforeEach(async () => {
  server = undefined as unknown as BuiltServer;
  root = await mkdtemp(join(tmpdir(), "cord-custom-readonly-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial");
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });

describe("自定义只读启动SDLC闭环", () => {
  it("同wrapper实现/宿主自测/只读评审后等待人审，最新快照独立协调也走只读分支", async () => {
    const run_id = await prepare();
    await wait(async () => (await server.sessions.listApprovals("REQ-MODES")).length === 1);
    expect((await calls()).map(call => [call.action, call.readonly])).toEqual([["write", false], ["review", true]]);
    const guide = await readFile(join(root, "cord", "REQ-MODES", "review.md"), "utf8"); expect(guide).toContain("宿主验证证据");
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect((await facts()).find(event => event.type === "agent.task.completed" && event.payload["node_id"] === "review")!.payload).toMatchObject({ status: "ok", artifact_written: false, written_by: "none" });
    expect((await server.runs.getRun(run_id)).status).toBe("waiting_human");
    const catalog = await api("GET", "/agents"); expect(catalog.body.agents.find((item: { name: string }) => item.name === "wrapper").capabilities).toMatchObject({ readonly_launch: "mapped", readonly_resume: "supported" });
    expect((await api("PUT", "/requirements/REQ-MODES/docs/prd", { content: "# PRD\nLATEST_READONLY_COORDINATION" })).status).toBe(200);
    const created = await api("POST", "/requirements/REQ-MODES/coordination", { agent: "wrapper", sdlc_id: "custom-modes" }); expect(created.status).toBe(202);
    const path = `/requirements/REQ-MODES/coordination/${created.body.round.round_id}`;
    await wait(async () => (await api("GET", path)).body.round.status === "ok");
    expect((await api("GET", path)).body.round).toMatchObject({ current: true, agent_context_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const last = (await calls()).at(-1); expect(last).toMatchObject({ readonly: true, action: "review", model: "fixture-model", effort: "high" });
    expect(last.prompt).toContain("LATEST_READONLY_COORDINATION"); expect(last.prompt).toContain('"readonly_launch":"mapped"');
    expect(sha256Hex(await readFile(join(root, "cord", "REQ-MODES", "review.md"), "utf8"))).toBe(sha256Hex(guide));
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });

  it("映射只读参数仍须审计工具；违规不重试，修复后保留上游Goal并重新评审", async () => {
    const run_id = await prepare(true); await wait(async () => !server.runs.isActive("REQ-MODES"));
    expect((await server.runs.getRun(run_id)).status).toBe("failed");
    expect((await calls()).map(call => call.action)).toEqual(["write", "review"]);
    expect((await facts()).find(event => event.type === "agent.task.completed" && event.payload["node_id"] === "review")!.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false });
    expect(await server.sessions.listApprovals("REQ-MODES")).toHaveLength(0);
    await configure(); const recovered = await api("POST", "/requirements/REQ-MODES/runs", { sdlc_id: "custom-modes" }); expect(recovered.status).toBe(202);
    await wait(async () => (await server.sessions.listApprovals("REQ-MODES")).length === 1);
    expect((await calls()).map(call => call.action)).toEqual(["write", "review", "review"]);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
