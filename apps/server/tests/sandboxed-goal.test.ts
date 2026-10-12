import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execa } from "execa";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { goalCommandHash, resolveGoalReadiness, hashEvent, create_worktree, type EventEnvelope } from "agent-cord";
import { createClient, type ApiClient } from "../../console/src/api.js";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const worker = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const coordinator = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
const req_id = "REQ-SANDBOX-GOAL";
const [node_major = 0, node_minor = 0] = process.versions.node.split(".").map(Number);
const native_available = process.platform === "darwin" && (node_major > 22 || node_major === 22 && node_minor >= 12)
  && (() => { try { createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"); return true; } catch { return false; } })();
let root: string; let server: BuiltServer | undefined; let client: ApiClient;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-sandbox-goal-http-")); await mkdir(join(root, "cord")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { vi.restoreAllMocks(); if (server !== undefined) { await server.app.close(); server.index.close(); server = undefined; } await rm(root, { recursive: true, force: true }); });
async function boot() { server = await buildApp({ root }); const base = await server.app.listen({ host: "127.0.0.1", port: 0 }); client = createClient(base); }
async function restart() { await server!.app.close(); server!.index.close(); server = undefined; await boot(); }
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() >= deadline) throw new Error("沙箱Goal等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function facts() { return (await server!.sessions.open(req_id)).events.readOrdered(); }
const calls = async () => Number(await readFile(join(root, ".goal-worker-calls"), "utf8"));
const verify_script = "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='fixed')process.exit(3);fs.writeFileSync(process.env.TMPDIR+'/check-cache','cached');if(process.env.CORD_TEST_FAKE_SECRET)process.exit(4);console.log('CHECK_PASSED');";

async function prepare(protocol: "headless" | "acp", script = verify_script, max_attempts = 3) {
  const proposal = { summary: "最新验证已就绪，等待人审", next_action: { kind: "wait", reason: "最终gate未决", evidence: [{ source: "workflow", id: "deliver" }] }, risks: [] };
  await writeFile(join(root, "cord/agents.yaml"), stringify({ agents: {
    worker: { kind: protocol, bin: process.execPath, args: [worker, ...(protocol === "acp" ? ["--acp"] : ["{{prompt}}"])] },
    coordinator: { kind: "headless", bin: process.execPath, args: [coordinator, "--mode", "claude", "--no-tools", "--result-text", JSON.stringify(proposal), "{{prompt}}"] },
  } }));
  await boot();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "sandbox-goal" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", goal: {
      inputs: ["value.txt"], review_changes: true, check_sandbox: "readonly_workspace", max_attempts,
      acceptance: [{ id: "value-fixed", criterion: "业务值与沙箱检查满足要求", checks: ["business"] }],
      checks: [{ id: "business", bin: process.execPath, args: ["-e", script], timeout_ms: 5000 }],
    } }, gates: [{ id: "human-review", role: { approvers: ["local-human"] }, attach: { node: "deliver", when: "post" },
      checks: [{ ref: "verification-passed", with: { verification_id: "business" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["deliver"] },
  ] } });
  await client.publishSdlc("sandbox-goal", yaml); await client.createRequirement({ req_id, title: "只读宿主检查" });
  await client.writeDoc(req_id, "prd", "# PRD\nSANDBOX_PRD_A：修复value.txt并交付当前实际检查与review指南。\n");
  return server!.sdlcs.get("sandbox-goal", 1);
}
async function coordinate() { const round = (await client.startCoordination(req_id, { agent: "coordinator", sdlc_id: "sandbox-goal" })).round;
  await wait_for(async () => (await client.getCoordination(req_id, round.round_id)).round.status === "ok"); return (await client.getCoordination(req_id, round.round_id)).round; }

describe.skipIf(!native_available)("严格宿主检查TCP Goal", () => {
  it("linked工作树严格检查保护公共Git元数据，actual ready/current与人工gate一致", async () => {
    const original = root; const destination = await mkdtemp(join(tmpdir(), "cord-sandbox-linked-"));
    try {
      await execa("git", ["init", "--initial-branch=main"], { cwd: root });
      await writeFile(join(root, ".gitignore"), "cord/\n"); await execa("git", ["add", "value.txt", ".gitignore"], { cwd: root });
      await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], { cwd: root });
      const worktree = await create_worktree(root, join(destination, "draft"), "HEAD"); root = worktree.root; await mkdir(join(root, "cord"));
      const script = verify_script + `try{require('node:fs').readFileSync(${JSON.stringify(join(worktree.common_directory, "config"))});process.exit(6)}catch{}`;
      const binding = await prepare("headless", script); const started = await client.startRun(req_id, { sdlc_id: "sandbox-goal" });
      await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
      expect(server!.agents.resolver()("worker").capabilities?.workspace_isolation).toBe("worktree");
      expect(await readFile(join(original, "value.txt"), "utf8")).toBe("initial"); expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
      const context = await readCoordinationExecutionContext(binding.def, await server!.sessions.open(req_id), binding.workflow_revision, server!.runs);
      expect(context.goals[0]).toMatchObject({ status: "ready", current: true });
      expect((await server!.runs.getRun(started.run.run_id)).status).toBe("waiting_human");
      expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    } finally {
      if (server !== undefined) { await server.app.close(); server.index.close(); server = undefined; }
      root = original; await rm(destination, { recursive: true, force: true });
    }
  });
  it.each(["headless", "acp"] as const)("%s自动修复后只读检查通过，当前ready/hash/指南/协调与cold人审统一", async protocol => {
    const binding = await prepare(protocol); const start = await client.startRun(req_id, { sdlc_id: "sandbox-goal" }, "strict-start");
    expect((await client.startRun(req_id, { sdlc_id: "sandbox-goal" }, "strict-start")).run.run_id).toBe(start.run.run_id);
    await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
    const history = await facts(); const node = binding.def.spec.nodes[0]!; const ready = history.find(event => event.type === "goal.attempt.completed" && event.payload["status"] === "ready")!;
    expect(await calls()).toBe(2); expect(history.filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    expect(resolveGoalReadiness(ready, history, node, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision, run_id: start.run.run_id })).not.toBeNull();
    const verify = history.filter(event => event.type === "verification.completed").at(-1)!;
    expect(verify.payload["command_hash"]).toBe(goalCommandHash(node.run!.goal!.checks[0]!, "readonly_workspace"));
    expect(verify.payload["command_hash"]).not.toBe(goalCommandHash(node.run!.goal!.checks[0]!));
    expect((await client.readArtifact(req_id, "review.md")).content).toContain("readonly_workspace");
    expect((await client.readArtifact(req_id, "review.md")).content).toContain("Sandbox Runtime 0.0.79");
    const context = await readCoordinationExecutionContext(binding.def, await server!.sessions.open(req_id), binding.workflow_revision, server!.runs);
    expect(context.goals[0]).toMatchObject({ status: "ready", current: true }); const old = await coordinate(); expect(old.current).toBe(true);
    const approval = (await client.getApprovals(req_id)).approvals[0]!; await restart();
    expect(await calls()).toBe(2); expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    await client.writeDoc(req_id, "prd", "# PRD\nSANDBOX_PRD_B：最新需求需要重新核验，保持人工未决。\n");
    expect((await client.getCoordination(req_id, old.round_id)).round.current).toBe(false);
    expect((await coordinate()).current).toBe(true);
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    await client.getLedger(req_id); expect((await client.doctor()).ok).toBe(true);
  });

  it.each(["source", "facts"])("检查试图写%s时原内容受保护，没有ready或人工放行，cold不重复", async mode => {
    const path = mode === "source" ? "value.txt" : `cord/${req_id}/events.jsonl`;
    await prepare("headless", `require('node:fs').writeFileSync(${JSON.stringify(path)},'mutated');`, 1);
    const start = await client.startRun(req_id, { sdlc_id: "sandbox-goal" }); await wait_for(async () => !server!.runs.isActive(req_id));
    expect((await server!.runs.getRun(start.run.run_id)).status).toBe("failed"); expect(await calls()).toBe(1);
    const history = await facts(); expect(history.filter(event => event.type === "verification.completed")).toHaveLength(1);
    expect(history.find(event => event.type === "verification.completed")!.payload).toMatchObject({ status: "failed" });
    expect(history.some(event => event.type === "goal.attempt.completed" && event.payload["status"] === "ready")).toBe(false);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("broken"); expect(history[0]?.type).toBe("session.created");
    await restart(); expect(await calls()).toBe(1); expect((await client.getApprovals(req_id)).approvals).toHaveLength(0);
    await client.getLedger(req_id); expect((await client.doctor()).ok).toBe(true);
  });

  it("被替换为裸hash的验证不能恢复/批准严格ready，原来源修复后仍未人审", async () => {
    const binding = await prepare("headless"); const start = await client.startRun(req_id, { sdlc_id: "sandbox-goal" });
    await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
    const approval = (await client.getApprovals(req_id)).approvals[0]!;
    const session = await server!.sessions.open(req_id); const read = session.events.readOrderedStrict!.bind(session.events);
    const invalid = async () => (await read()).map(event => event.type === "verification.completed" ?
      { ...event, payload: { ...event.payload, command_hash: goalCommandHash(binding.def.spec.nodes[0]!.run!.goal!.checks[0]!) } } : event);
    const mock = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(invalid);
    const ordered_mock = vi.spyOn(session.events, "readOrdered").mockImplementation(invalid);
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    const context = await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server!.runs);
    expect(context.goals[0]).toMatchObject({ status: "invalid", current: false }); mock.mockRestore(); ordered_mock.mockRestore();
    expect((await server!.runs.getRun(start.run.run_id)).status).toBe("waiting_human"); expect(await calls()).toBe(2);
    expect((await facts()).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
  });

  it("冷恢复实际历史被改为裸检查hash时拒绝严格ready，不重做worker或消费审批", async () => {
    const binding = await prepare("headless"); const start = await client.startRun(req_id, { sdlc_id: "sandbox-goal" });
    await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1);
    const history = await facts(); const approval = (await client.getApprovals(req_id)).approvals[0]!;
    const session_dir = (await server!.sessions.open(req_id)).dir;
    await server!.app.close(); server!.index.close(); server = undefined;
    const changed: EventEnvelope[] = [];
    for (const event of history) changed.push({ ...event, prev_event_hash: changed.length === 0 ? null : hashEvent(changed.at(-1)!),
      payload: event.type === "verification.completed" ? { ...event.payload, command_hash: goalCommandHash(binding.def.spec.nodes[0]!.run!.goal!.checks[0]!) } : event.payload });
    await writeFile(join(session_dir, "events.jsonl"), changed.map(event => JSON.stringify(event)).join("\n") + "\n");
    await boot(); expect((await server!.runs.getRun(start.run.run_id)).status).toBe("failed"); expect(await calls()).toBe(2);
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await facts()).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
  });
});
