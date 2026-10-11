import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_worktree } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient, type ApiClient } from "../../console/src/api.js";

const headless_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/stdin-prompt-worker.mjs", import.meta.url));
const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/goal-worker.mjs", import.meta.url));
const req_id = "REQ-WORKTREE";
let directory: string;
let source: string;
const servers = new Set<BuiltServer>();
const git = (cwd: string, args: string[]) => execa("git", args, { cwd });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cord-worktree-http-")); source = join(directory, "source"); await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await writeFile(join(source, "value.txt"), "initial"); await writeFile(join(source, "unit.txt"), "base");
  await writeFile(join(source, ".gitignore"), "cord/\n"); await git(source, ["add", "."]);
  await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  await git(source, ["config", "merge.cord-event-log.driver", "cord-merge-driver %O %A %B"]);
});
async function close(server: BuiltServer) { if (!servers.delete(server)) return; await server.app.close(); server.index.close(); }
afterEach(async () => { await Promise.all([...servers].map(close)); await rm(directory, { recursive: true, force: true }); });
async function boot(root: string) { const server = await buildApp({ root }); servers.add(server); const base = await server.app.listen({ host: "127.0.0.1", port: 0 }); return { server, client: createClient(base) }; }
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() >= deadline) throw new Error("worktree TCP等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
const events = async (server: BuiltServer) => (await server.sessions.open(req_id)).events.readOrdered();
async function calls(root: string, protocol: string) {
  return protocol === "acp" ? JSON.parse("[" + (await readFile(join(root, ".goal-worker-prompts.jsonl"), "utf8")).trim().split("\n").join(",") + "]")
    : (await readFile(join(root, ".stdin-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
async function prepare(protocol: "headless" | "acp", name: string) {
  const worktree = await create_worktree(source, join(directory, name)); const root = worktree.root;
  await mkdir(join(root, "cord")); await writeFile(join(root, "unit.txt"), name);
  const agent = protocol === "acp" ? {
    kind: "acp", bin: process.execPath, args: [acp_fixture, "--acp", "--launch-config", "--provider-config", "--profile-worker"],
    launch: { provider: "openai", model: "large", effort: "high", mode: "code", option_ids: { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" } },
    readonly_launch: { provider: "openai", model: "small", effort: "low", mode: "plan", option_ids: { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" } },
  } : {
    kind: "headless", bin: process.execPath, prompt_input: "stdin",
    args: [headless_fixture, "--operation", "workflow", "--model", "{{model}}", "--effort", "{{effort}}", "--readonly", "{{readonly}}", "-"],
    launch: { model: "writer", effort: "high" }, readonly_launch: { model: "reviewer", effort: "low" },
  };
  await writeFile(join(root, "cord/agents.yaml"), stringify({ agents: { worker: agent } }));
  const running = await boot(root); const { client } = running;
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "worktree-goal" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", require_capabilities: { workspace_isolation: "worktree" }, goal: {
      inputs: ["value.txt", "unit.txt"], max_attempts: 3, review_changes: true,
      acceptance: [{ id: "unit-value", criterion: "当前工作单元业务值和身份正确", checks: ["unit-test"] }],
      checks: [{ id: "unit-test", bin: process.execPath, args: ["-e", `const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8')==='fixed'&&fs.readFileSync('unit.txt','utf8')===${JSON.stringify(name)}?0:3)`] }],
    } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text", require_capabilities: { workspace_isolation: "worktree" } },
      gates: [{ id: "human-review", role: { approvers: ["local-human"] }, attach: { node: "review", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["review"] },
  ] } });
  await client.publishSdlc("worktree-goal", yaml); await client.createRequirement({ req_id, title: name });
  await client.writeDoc(req_id, "prd", `# PRD\nPRD_${name}_A：修复当前工作单元并交付实际自测和review。\n`);
  return { ...running, worktree, root, client };
}
async function coordinate(client: ApiClient) {
  const started = await client.startCoordination(req_id, { agent: "worker", sdlc_id: "worktree-goal" });
  await wait_for(async () => (await client.getCoordination(req_id, started.round.round_id)).round.status === "ok");
  return (await client.getCoordination(req_id, started.round.round_id)).round;
}

describe("linked工作树TCP交付与恢复", () => {
  it("ACP无prompt查询绑定实际工作树，坏metadata拒绝且恢复可重查", async () => {
    const running = await prepare("acp", "query");
    const hash = running.server.agents.resolver()("worker").configuration_hash;
    const inspected = await running.client.inspectAgent("worker", undefined, { readonly: true });
    expect(inspected).toMatchObject({ current: true, configuration_hash: hash, capabilities: { workspace_isolation: "worktree" } });
    expect(inspected.observation).not.toBeNull(); await expect(readFile(join(running.root, ".goal-worker-calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await rename(join(running.root, ".git"), join(running.root, ".git.saved"));
    await expect(running.client.inspectAgent("worker", undefined, { readonly: true })).rejects.toMatchObject({ status: 409 });
    await rename(join(running.root, ".git.saved"), join(running.root, ".git"));
    expect((await running.client.inspectAgent("worker", undefined, { readonly: true })).current).toBe(true);
    await expect(readFile(join(running.root, ".goal-worker-calls"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["headless", "acp"] as const)("%s整单元使用同一工作树，独立只读profile/最新需求/自测/人审与cold不重复", async protocol => {
    let running = await prepare(protocol, "one"); const root = running.root;
    const catalog = await running.client.listAgents(); const worker = catalog.agents.find(agent => agent.name === "worker")!;
    expect(worker.capabilities?.workspace_isolation).toBe("worktree");
    const started = await running.client.startRun(req_id, { sdlc_id: "worktree-goal" });
    await wait_for(async () => (await running.client.getApprovals(req_id)).approvals.length === 1);
    expect((await running.server.runs.getRun(started.run.run_id)).status).toBe("waiting_human");
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("initial"); expect(await readFile(join(root, "value.txt"), "utf8")).toBe("fixed");
    const guide = await running.client.readArtifact(req_id, "review.md"); expect(guide.content).toContain(root); expect(guide.content).toContain("宿主验收覆盖");
    expect((await running.client.readArtifact(req_id, "findings.md")).content).toContain("风险");
    const facts = await calls(root, protocol);
    if (protocol === "acp") { expect(facts[0].configuration).toMatchObject({ llm: "large", thinking: "high", workflow: "code" }); expect(facts.at(-1).configuration).toMatchObject({ llm: "small", thinking: "low", workflow: "plan" }); }
    else { expect(facts[0]).toMatchObject({ model: "writer", effort: "high", readonly: false }); expect(facts.at(-1)).toMatchObject({ model: "reviewer", effort: "low", readonly: true }); }
    const proposal = await coordinate(running.client); expect(proposal.current).toBe(true); expect(proposal.agent_configuration_hash).toBe(worker.configuration_hash);
    expect(running.server.runs.isActive(req_id)).toBe(true);
    const approval = (await running.client.getApprovals(req_id)).approvals[0]!; const count = (await calls(root, protocol)).length;
    await close(running.server); running = { ...running, ...await boot(root) };
    expect((await calls(root, protocol)).length).toBe(count); expect((await running.client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    const cold_run = await running.server.runs.getRun(started.run.run_id);
    expect(cold_run.status).toBe("waiting_human"); expect(running.server.runs.isActive(req_id)).toBe(false);
    expect((await running.client.getCoordination(req_id, proposal.round_id)).round.current).toBe(false);
    const restored = await coordinate(running.client); expect(restored.current).toBe(true);
    await running.client.writeDoc(req_id, "prd", "# PRD\nPRD_one_B：最新事实仍等待最终人审。\n");
    expect((await running.client.getCoordination(req_id, restored.round_id)).round.current).toBe(false);
    const latest = await coordinate(running.client); expect(latest.current).toBe(true);
    const prompt = (await calls(root, protocol)).at(-1).prompt; expect(prompt).toContain("PRD_one_B"); expect(prompt).not.toContain("PRD_one_A");
    expect((await events(running.server)).filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited" && event.payload["node_id"] === "done")).toHaveLength(0);
    await running.client.getLedger(req_id);
    const doctor = await running.client.doctor(); expect(doctor.ok, JSON.stringify(doctor.checks.filter(check => !check.ok))).toBe(true);
  });

  it("两个server同一需求/流程ID在不同工作树可同时等待，不共享源码/事件/lease/配置身份", async () => {
    const first = await prepare("headless", "left"); const second = await prepare("acp", "right");
    const [a, b] = await Promise.all([first.client.startRun(req_id, { sdlc_id: "worktree-goal" }), second.client.startRun(req_id, { sdlc_id: "worktree-goal" })]);
    await wait_for(async () => (await first.client.getApprovals(req_id)).approvals.length === 1 && (await second.client.getApprovals(req_id)).approvals.length === 1);
    expect(first.server.runs.workspaceLeaseStatus().state).toBe("held"); expect(second.server.runs.workspaceLeaseStatus().state).toBe("held");
    expect(a.run.run_id).not.toBe(b.run.run_id); expect(first.server.agents.resolver()("worker").configuration_hash).not.toBe(second.server.agents.resolver()("worker").configuration_hash);
    expect(await readFile(join(first.root, "unit.txt"), "utf8")).toBe("left"); expect(await readFile(join(second.root, "unit.txt"), "utf8")).toBe("right");
    const [left, right] = await Promise.all([coordinate(first.client), coordinate(second.client)]);
    await first.client.writeDoc(req_id, "prd", "# PRD\nONLY_LEFT_B\n");
    expect((await first.client.getCoordination(req_id, left.round_id)).round.current).toBe(false);
    expect((await second.client.getCoordination(req_id, right.round_id)).round.current).toBe(true);
    expect((await events(first.server)).some(event => event.payload["run_id"] === b.run.run_id)).toBe(false);
    expect((await events(second.server)).some(event => event.payload["run_id"] === a.run.run_id)).toBe(false);
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("initial");
  });

  it("人审等待期间工作树身份漂移拒绝验证/审批/协调/重载，恢复后保留原run与模型调用", async () => {
    const running = await prepare("headless", "one"); const started = await running.client.startRun(req_id, { sdlc_id: "worktree-goal" });
    await wait_for(async () => (await running.client.getApprovals(req_id)).approvals.length === 1);
    const proposal = await coordinate(running.client); const approval = (await running.client.getApprovals(req_id)).approvals[0]!;
    const count = (await calls(running.root, "headless")).length;
    await rename(join(running.root, ".git"), join(running.root, ".git.saved"));
    await expect(running.client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 });
    expect((await running.client.getCoordination(req_id, proposal.round_id)).round.current).not.toBe(true);
    await expect(running.client.reloadAgents()).rejects.toThrow();
    expect((await events(running.server)).filter(event => event.type === "human.decision.recorded")).toHaveLength(0);
    await rename(join(running.root, ".git.saved"), join(running.root, ".git")); await running.client.reloadAgents();
    expect((await running.client.getCoordination(req_id, proposal.round_id)).round.current).toBe(true);
    expect((await running.server.runs.getRun(started.run.run_id)).status).toBe("waiting_human"); expect((await calls(running.root, "headless")).length).toBe(count);
  });
});
