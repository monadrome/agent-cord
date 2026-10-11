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
const common = ["--model", "{{model}}", "--effort", "{{effort}}", "--prompt", "{{prompt}}", "--readonly", "{{readonly}}"];
async function configure(command: unknown) {
  await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: { kind: "headless", bin: process.execPath,
    args: [fixture, "--operation", "write", ...common], readonly_args: [fixture, "--operation", "review", ...common, "--emit-command", JSON.stringify(command)],
    launch: { model: "writer-model", effort: "high" }, readonly_launch: { model: "review-model", effort: "low" },
  } } }));
  if (server) await server.agents.reload();
}
async function api(method: "GET" | "POST" | "PUT", path: string, payload?: unknown) {
  const response = await fetch(base + "/api/v1" + path, { method, headers: { ...(method === "GET" ? {} : { "idempotency-key": ulid() }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
async function wait(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) {
  if (Date.now() >= deadline) throw new Error("只读命令TCP验收超时"); await new Promise(resolve => setTimeout(resolve, 15));
} }
const facts = () => server.sessions.readEvents("REQ-COMMANDS");
const calls = async () => (await readFile(join(root, ".mode-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function restart() {
  if (server) { await server.app.close(); server.index.close(); }
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
}
async function prepare(command: unknown) {
  await configure(command); await restart();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "readonly-command" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: { inputs: ["value.txt"], review_changes: true,
      checks: [{ id: "value-check", bin: process.execPath, args: ["-e", "if(require('node:fs').readFileSync('value.txt','utf8')!=='fixed')process.exit(1)"] }] } } },
    { id: "review", artifact: "review.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, retry: { max_attempts: 3, backoff_ms: 0 } },
      gates: [{ id: "human-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
  ] } });
  expect((await api("POST", "/sdlcs/readonly-command/versions/publish", { yaml })).status).toBe(201);
  expect((await api("POST", "/requirements", { req_id: "REQ-COMMANDS", title: "只读命令按选项审计", prd: "# PRD\nLATEST_COMMAND_A：代码与自测，评审最后人工决定。" })).status).toBe(201);
  return start();
}
async function start() { const result = await api("POST", "/requirements/REQ-COMMANDS/runs", { sdlc_id: "readonly-command" }); expect(result.status).toBe(202); return result.body.run.run_id as string; }
beforeEach(async () => { server = undefined as unknown as BuiltServer; root = await mkdtemp(join(tmpdir(), "cord-readonly-commands-tcp-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(root, { recursive: true, force: true }); });

describe("只读命令审计TCP交付与恢复", () => {
  it.each([
    { command: "rg --pre=PRIVATE_EXEC pattern src" }, { argv: ["git", "diff", "--output=PRIVATE_OUTPUT"] },
    { argv: ["find", "src", "-fprint", "PRIVATE_OUTPUT"] },
  ])("危险命令%j不重试/不消耗上游Goal，修复只读配置后待人审/cold不重复", async command => {
    const run_id = await prepare(command); await wait(async () => !server.runs.isActive("REQ-COMMANDS"));
    expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect((await calls()).map(call => call.action)).toEqual(["write", "review"]);
    const before = await facts(); const task = before.find(event => event.type === "agent.task.completed" && event.payload["node_id"] === "review")!;
    expect(task.payload).toMatchObject({ status: "failed", failure_stage: "driver", retryable: false }); expect(JSON.stringify(task)).not.toContain("PRIVATE");
    expect(await server.sessions.listApprovals("REQ-COMMANDS")).toHaveLength(0);
    const guide = await readFile(join(root, "cord", "REQ-COMMANDS", "review.md"), "utf8"); expect(guide).toContain("宿主验证证据");
    await restart(); expect((await server.runs.getRun(run_id)).status).toBe("failed"); expect(await calls()).toHaveLength(2);
    await configure({ argv: ["rg", "--fixed-strings", "pattern with spaces; $(literal)", "src"] }); const recovered = await start();
    await wait(async () => (await server.sessions.listApprovals("REQ-COMMANDS")).length === 1);
    expect((await calls()).map(call => call.action)).toEqual(["write", "review", "review"]);
    expect(sha256Hex(await readFile(join(root, "cord", "REQ-COMMANDS", "review.md"), "utf8"))).toBe(sha256Hex(guide));
    const approval = (await server.sessions.listApprovals("REQ-COMMANDS"))[0]!;
    await restart(); expect(await calls()).toHaveLength(3); expect((await server.runs.getRun(recovered)).status).toBe("waiting_human");
    expect((await server.sessions.listApprovals("REQ-COMMANDS"))[0]!.approval_id).toBe(approval.approval_id);
    expect((await api("PUT", "/requirements/REQ-COMMANDS/docs/prd", { content: "# PRD\nLATEST_COMMAND_B：最新需求保留最终人审。" })).status).toBe(200);
    const created = await api("POST", "/requirements/REQ-COMMANDS/coordination", { agent: "worker", sdlc_id: "readonly-command" }); expect(created.status).toBe(202);
    const path = `/requirements/REQ-COMMANDS/coordination/${created.body.round.round_id}`;
    await wait(async () => (await api("GET", path)).body.round.status === "ok");
    expect((await api("GET", path)).body.round).toMatchObject({ current: true, proposal: { next_action: { kind: "wait" } } });
    expect((await calls()).at(-1)).toMatchObject({ action: "review", model: "review-model", effort: "low" }); expect((await calls()).at(-1).prompt).toContain("LATEST_COMMAND_B");
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "coordinator.round.adopted")).toHaveLength(0);
    expect((await facts()).filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
  });
});
