import { native_sandbox_available } from "../../../tests/helpers/native-sandbox.js";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_worktree, canonicalJson, sha256Hex, read_coordination_agents } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient, type ApiClient } from "../../console/src/api.js";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/sandbox-worker.mjs", import.meta.url));
const native = native_sandbox_available;
const req_id = "REQ-WORKER-SANDBOX";
let directory: string; let root: string; let server: BuiltServer; let client: ApiClient;
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; directory = await mkdtemp(join(tmpdir(), "cord-worker-sandbox-http-"));
  const source = join(directory, "source"); await mkdir(source); await execa("git", ["init", "--initial-branch=main"], { cwd: source });
  await writeFile(join(source, "value.txt"), "initial"); await writeFile(join(source, ".gitignore"), "cord/\n");
  await execa("git", ["add", "."], { cwd: source }); await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], { cwd: source });
  await execa("git", ["config", "merge.cord-event-log.driver", "cord-merge-driver %O %A %B"], { cwd: source });
  root = (await create_worktree(source, join(directory, "workspace"))).root;
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(directory, { recursive: true, force: true }); });
async function boot() { server = await buildApp({ root }); client = createClient(await server.app.listen({ host: "127.0.0.1", port: 0 })); }
async function close() { await server.app.close(); server.index.close(); }
async function wait_for(test: () => Promise<boolean>) { const deadline = Date.now() + 15000; while (!await test()) { if (Date.now() >= deadline) throw new Error("Worker sandbox TCP等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function events() { return (await server.sessions.open(req_id)).events.readOrdered(); }
async function calls() { const base = join(directory, "state"); let count = 0; try { for (const path of await readdir(base)) { try { count += Number(await readFile(join(base, path, "session.txt"), "utf8")); } catch {} } } catch {} return count; }
function configuration(protocol: "acp" | "headless", changed = false, never = false) {
  const sandbox = { kind: "workspace", read_paths: [dirname(fixture)], state_dir: join(directory, "state"), allowed_domains: changed ? ["api.example.com"] : [] };
  return stringify({ agents: { worker: protocol === "acp" ? {
    kind: "acp", bin: process.execPath, args: [fixture, "--acp", "--first-broken", "--operation", never ? "never" : "workflow"], sandbox,
    launch: { mode: "code", option_ids: { mode: "workflow" } }, readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } },
  } : { kind: "headless", bin: process.execPath, prompt_input: "stdin", sandbox,
    args: [fixture, "--first-broken", "--operation", never ? "never" : "workflow", "--readonly", "{{readonly}}", "-"],
  } } });
}
async function prepare(protocol: "acp" | "headless", never = false) {
  await mkdir(join(root, "cord")); await writeFile(join(root, "cord/agents.yaml"), configuration(protocol, false, never)); await boot();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "sandbox-goal" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", output: "text", input_scope: { kind: "dependencies" }, require_capabilities: { workspace_isolation: "os_sandbox" },
      goal: { inputs: ["value.txt"], review_changes: true, max_attempts: 2, checks: [{ id: "unit-test", bin: process.execPath, args: ["-e", "process.exit(require('node:fs').readFileSync('value.txt','utf8')==='fixed'?0:3)"] }] } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text", input_scope: { kind: "dependencies" }, require_capabilities: { workspace_isolation: "os_sandbox" } },
      gates: [{ id: "final-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "goal-ready", with: { node_id: "deliver" } }, { ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["review"] },
  ] } });
  await client.publishSdlc("sandbox-goal", yaml); await client.createRequirement({ req_id, title: "实际隔离Goal与readonly评审" }); await client.writeDoc(req_id, "prd", "# PRD\n将value.txt修复为fixed，交付当前自测/指南并保留最终人审。\n");
  return (await client.startRun(req_id, { sdlc_id: "sandbox-goal" })).run;
}

const native_it = native ? it : it.skip;
describe("Worker OS沙箱实际TCP交付与协调", () => {
  native_it.each(["headless", "acp"] as const)("%s自动实现/宿主自测/只读评审，当前协调含同一能力，cold零重跑且最终人工", async protocol => {
    const run = await prepare(protocol); await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
    expect(await calls()).toBe(3); const approval = (await client.getApprovals(req_id)).approvals[0]!;
    expect((await events()).filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    const catalog = await client.listAgents(); expect(catalog.agents.find(item => item.name === "worker")?.capabilities).toMatchObject({ workspace_isolation: "os_sandbox", sandbox: { state: "persistent" } });
    expect(JSON.stringify(catalog)).not.toContain(directory); expect(JSON.stringify(catalog)).not.toContain("allowed_domains");
    expect((await client.readArtifact(req_id, "review.md")).content).toContain("宿主验证证据"); expect((await client.readArtifact(req_id, "findings.md")).content).toContain("风险");
    const round = await client.startCoordination(req_id, { agent: "worker", sdlc_id: "sandbox-goal" }); await wait_for(async () => (await client.getCoordination(req_id, round.round.round_id)).round.status === "ok");
    const binding = await server.sdlcs.get("sandbox-goal", 1); const session = await server.sessions.open(req_id);
    const completed = (await client.getCoordination(req_id, round.round.round_id)).round; expect(completed.current).toBe(true);
    const agents = read_coordination_agents(binding.def, server.agents.resolver()); expect(agents[0]?.capabilities).toMatchObject({ workspace_isolation: "os_sandbox", sandbox: { network: "allowlist" } });
    expect(completed.agent_context_hash).toBe(sha256Hex(canonicalJson(agents)));
    expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).goals[0]).toMatchObject({ current: true, status: "ready" });
    const count = await calls(); await close(); await boot(); expect(await calls()).toBe(count); expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    if (protocol === "acp") { const inspected = await client.inspectAgent("worker", undefined, { readonly: true }); expect(inspected).toMatchObject({ current: true, capabilities: { workspace_isolation: "os_sandbox" }, observation: { native_resume: true } }); expect(await calls()).toBe(count); }
    expect((await events()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("completed"); expect(await calls()).toBe(count);
    expect(await readFile(join(directory, "source/value.txt"), "utf8")).toBe("initial"); expect((await client.doctor()).ok).toBe(true);
  });
  native_it.each(["headless", "acp"] as const)("%scold策略变化不沿用旧Goal证据、不增加预算，旧人工选择409", async protocol => {
    const run = await prepare(protocol); await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1); const approval = (await client.getApprovals(req_id)).approvals[0]!;
    await close(); await writeFile(join(root, "cord/agents.yaml"), configuration(protocol, true)); await boot(); await wait_for(async () => !server.runs.isActive(req_id));
    expect((await server.runs.getRun(run.run_id)).status).toBe("blocked"); await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await events()).filter(event => event.type === "workflow.run.started" || event.type === "goal.attempt.started")).toHaveLength(3);
    expect((await events()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited" && event.payload["node_id"] !== "deliver")).toHaveLength(0);
  });
  native_it("活动沙箱Goal取消真实进程后不自测、不ready、不形成最终审批", async () => {
    const run = await prepare("acp", true); await wait_for(async () => await calls() > 0);
    await client.cancelRun(run.run_id); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("cancelled");
    expect((await events()).filter(event => event.type === "verification.completed" || event.type === "gate.waiting" || event.type === "workflow.node.exited")).toHaveLength(0);
    await close(); await boot(); expect(await calls()).toBe(1); expect((await client.getApprovals(req_id)).approvals).toHaveLength(0);
  });
});
