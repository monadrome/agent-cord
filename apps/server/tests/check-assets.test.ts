import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execa } from "execa";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_worktree, sha256Hex, goalCommandHash, check_assets_hash, resolveGoalReadiness } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient, type ApiClient } from "../../console/src/api.js";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/sandbox-worker.mjs", import.meta.url));
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const native = process.platform === "darwin" && (major > 22 || major === 22 && minor >= 12) && (() => { try { createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"); return true; } catch { return false; } })();
const req_id = "REQ-PINNED-CHECK";
const verifier = "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='fixed'){console.error('PINNED_VALUE_FAILURE');process.exit(3)}console.log('PINNED_VALUE_PASSED');";
let directory: string; let root: string; let assets_root: string; let server: BuiltServer; let client: ApiClient;
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; directory = await mkdtemp(join(tmpdir(), "cord-pinned-http-")); const source = join(directory, "source"); assets_root = join(directory, "trusted"); await mkdir(source); await mkdir(assets_root); await writeFile(join(assets_root, "verify.cjs"), verifier);
  await execa("git", ["init", "--initial-branch=main"], { cwd: source }); await writeFile(join(source, "value.txt"), "initial"); await writeFile(join(source, "local-tests.cjs"), "process.exit(3)\n"); await writeFile(join(source, ".gitignore"), "cord/\n");
  await execa("git", ["add", "."], { cwd: source }); await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], { cwd: source });
  await execa("git", ["config", "merge.cord-event-log.driver", "cord-merge-driver %O %A %B"], { cwd: source }); root = (await create_worktree(source, join(directory, "workspace"))).root;
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(directory, { recursive: true, force: true }); });
async function boot() { server = await buildApp({ root }); client = createClient(await server.app.listen({ host: "127.0.0.1", port: 0 })); }
async function close() { await server.app.close(); server.index.close(); }
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() >= deadline) throw Error("固定验证TCP等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function facts() { return (await server.sessions.open(req_id)).events.readOrdered(); }
async function calls() { let count = 0; try { for (const path of await readdir(join(directory, "state"))) { try { count += Number(await readFile(join(directory, "state", path, "session.txt"), "utf8")); } catch {} } } catch {} return count; }
async function prepare(protocol: "headless" | "acp", never_fix = false, review = true, invalid = false) {
  await mkdir(join(root, "cord")); const sandbox = { kind: "workspace", read_paths: [dirname(fixture)], state_dir: join(directory, "state") };
  const args = [fixture, "--first-broken", "--tamper-local-tests", "--asset-file", join(assets_root, "verify.cjs"), ...(never_fix ? ["--never-fix"] : []), "--operation", "workflow"];
  const agent = protocol === "acp" ? { kind: "acp", bin: process.execPath, args: [...args, "--acp"], sandbox, launch: { mode: "code", option_ids: { mode: "workflow" } }, readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } } }
    : { kind: "headless", bin: process.execPath, prompt_input: "stdin", args: [...args, "--readonly", "{{readonly}}", "-"], sandbox };
  await writeFile(join(root, "cord/agents.yaml"), stringify({ agents: { worker: agent } })); await boot();
  const gate = (node: string) => ({ id: "final-review", role: {}, attach: { node, when: "post" }, checks: [{ ref: "goal-ready", with: { node_id: "deliver" } }, { ref: "file-nonempty", with: { path: review ? "findings.md" : "review.md" } }], pass: { human_confirm: true }, on_fail: "block" });
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "pinned-goal" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", output: "text", input_scope: { kind: "dependencies" }, require_capabilities: { workspace_isolation: "os_sandbox" }, goal: {
      inputs: ["value.txt", "local-tests.cjs"], max_attempts: 3, review_changes: true, check_sandbox: "readonly_workspace",
      acceptance: [{ id: "value-fixed", criterion: "独立pin验证业务值fixed", checks: ["business"] }],
      checks: [{ id: "business", bin: process.execPath, args: ["{{check_assets}}/verify.cjs"], timeout_ms: 5000, assets: { root: assets_root, files: [{ file: "verify.cjs", content_hash: sha256Hex(verifier) }] } }],
    } }, gates: review ? [] : [gate("deliver")] },
    ...(review ? [{ id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text", input_scope: { kind: "dependencies" } }, gates: [gate("review")] }] : []),
    { id: "done", depends_on: [review ? "review" : "deliver"] },
  ] } });
  await client.publishSdlc("pinned-goal", yaml); await client.createRequirement({ req_id, title: "固定验证资产Goal" }); await client.writeDoc(req_id, "prd", "# PRD\n修复value.txt为fixed，修改本地tests不替代已发布的外部验证。\n");
  if (invalid) await writeFile(join(assets_root, "verify.cjs"), "process.exit(0)\n");
  return (await client.startRun(req_id, { sdlc_id: "pinned-goal" })).run;
}

const native_it = native ? it : it.skip;
describe("固定独立验证资产的Goal实际TCP", () => {
  native_it.each(["headless", "acp"] as const)("%s改本地测试/尝试改外部资产仍真实失败，修复业务后ready/指南/协调/cold/最终人审统一", async protocol => {
    const run = await prepare(protocol); await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
    let history = await facts(); expect(history.filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    expect(await readFile(join(root, "local-tests.cjs"), "utf8")).toBe("process.exit(0)\n"); expect(await readFile(join(assets_root, "verify.cjs"), "utf8")).toBe(verifier);
    for (const path of await readdir(join(directory, "state"))) { try { const probes = (await readFile(join(directory, "state", path, "trusted-probes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); expect(probes).toHaveLength(2); expect(probes.every(probe => probe.external_write === "blocked")).toBe(true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    const binding = await server.sdlcs.get("pinned-goal", 1); const node = binding.def.spec.nodes[0]!; const ready = history.filter(event => event.type === "goal.attempt.completed").at(-1)!;
    expect(resolveGoalReadiness(ready, history, node, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, run_id: run.run_id })).not.toBeNull();
    expect(history.filter(event => event.type === "verification.completed").at(-1)?.payload["command_hash"]).toBe(goalCommandHash(node.run!.goal!.checks[0]!, "readonly_workspace"));
    const guide = (await client.readArtifact(req_id, "review.md")).content; expect(guide).toContain("固定验证资产"); expect(guide).toContain(check_assets_hash(node.run!.goal!.checks[0]!.assets!));
    const old_proof = history.map(event => event.type === "verification.completed" ? { ...event, payload: { ...event.payload, command_hash: "a".repeat(64) } } : event);
    expect(resolveGoalReadiness(ready, old_proof, node, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, run_id: run.run_id })).toBeNull();
    const count = await calls(); const approval = (await client.getApprovals(req_id)).approvals[0]!; await close(); await boot(); expect(await calls()).toBe(count);
    const round = await client.startCoordination(req_id, { agent: "worker", sdlc_id: "pinned-goal" }); await wait_for(async () => (await client.getCoordination(req_id, round.round.round_id)).round.status === "ok");
    expect((await client.getCoordination(req_id, round.round.round_id)).round.current).toBe(true); expect((await readCoordinationExecutionContext(binding.def, await server.sessions.open(req_id), binding.workflow_revision, server.runs)).goals[0]).toMatchObject({ current: true });
    history = await facts(); expect(history.filter(event => event.type === "human.decision.recorded")).toHaveLength(0); expect(history.filter(event => event.type === "workflow.node.exited").map(event => event.payload["node_id"])).toEqual(["deliver"]);
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("completed"); expect((await client.doctor()).ok).toBe(true);
  });
  native_it.each(["headless", "acp"] as const)("%s持续只改测试不能ready，保留失败预算并不生成审批", async protocol => {
    const run = await prepare(protocol, true); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("failed");
    expect(await calls()).toBe(2); expect((await facts()).filter(event => event.type === "verification.completed").every(event => event.payload["status"] === "failed")).toBe(true);
    expect((await client.getApprovals(req_id)).approvals).toHaveLength(0); await close(); await boot(); expect(await calls()).toBe(2);
  });
  native_it("固定资产启动前漂移，零worker/检查派发；当前材料修复需要明确新执行", async () => {
    const run = await prepare("headless", false, true, true); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("failed");
    expect(await calls()).toBe(0); expect((await facts()).filter(event => event.type === "agent.task.started" || event.type === "verification.completed")).toHaveLength(0);
    expect((await client.getApprovals(req_id)).approvals).toHaveLength(0);
  });
  native_it("自身人审等待时资产漂移409/不可用，cold不重跑；还原原pin后原审批可消费", async () => {
    const run = await prepare("headless", false, false); await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1); const approval = (await client.getApprovals(req_id)).approvals[0]!; const count = await calls();
    await close(); await writeFile(join(assets_root, "verify.cjs"), "process.exit(0)\n"); await boot(); expect(await calls()).toBe(count);
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await server.runs.getRun(run.run_id)).status).toBe("waiting_human"); expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await writeFile(join(assets_root, "verify.cjs"), verifier); await client.decideApproval(req_id, approval.approval_id, approval.options[0]!);
    await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("completed"); expect(await calls()).toBe(count);
  });
  native_it("跨节点最终人审时资产漂移使旧ready失效，cold原run阻断且协调不能冒称当前", async () => {
    const run = await prepare("acp"); await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1); const approval = (await client.getApprovals(req_id)).approvals[0]!; const count = await calls();
    await close(); await writeFile(join(assets_root, "verify.cjs"), "process.exit(0)\n"); await boot(); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("blocked"); expect(await calls()).toBe(count);
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 }); const binding = await server.sdlcs.get("pinned-goal", 1);
    expect((await readCoordinationExecutionContext(binding.def, await server.sessions.open(req_id), binding.workflow_revision, server.runs)).goals[0]?.current).not.toBe(true);
    expect((await facts()).filter(event => event.type === "workflow.run.started")).toHaveLength(1); expect((await facts()).filter(event => event.type === "goal.attempt.started")).toHaveLength(2); expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });
});
