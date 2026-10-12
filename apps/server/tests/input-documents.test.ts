import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execa } from "execa";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_worktree, sha256Hex } from "agent-cord";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { createClient, type ApiClient } from "../../console/src/api.js";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/sandbox-worker.mjs", import.meta.url));
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const native = process.platform === "darwin" && (major > 22 || major === 22 && minor >= 12) && (() => { try { createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"); return true; } catch { return false; } })();
const req_id = "REQ-FULL-INPUT";
const prd = "# PRD\nHEAD_REQUIREMENT\n" + "a".repeat(30000) + "\nMID_ONLY_VALUE=7\n" + "b".repeat(30000) + "\nLATEST_TAIL\n";
const manual = "# Manual\n" + "m".repeat(30000) + "\nMANUAL_MID_ONLY\n" + "n".repeat(30000) + "\nEND\n";
let directory: string; let root: string; let server: BuiltServer; let client: ApiClient;
beforeEach(async () => {
  server = undefined as unknown as BuiltServer; directory = await mkdtemp(join(tmpdir(), "cord-full-input-http-")); const source = join(directory, "source"); await mkdir(source);
  await execa("git", ["init", "--initial-branch=main"], { cwd: source }); await writeFile(join(source, "value.txt"), "initial"); await writeFile(join(source, "document-value.txt"), "0"); await writeFile(join(source, ".gitignore"), "cord/\n");
  await execa("git", ["add", "."], { cwd: source }); await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], { cwd: source });
  await execa("git", ["config", "merge.cord-event-log.driver", "cord-merge-driver %O %A %B"], { cwd: source }); root = (await create_worktree(source, join(directory, "workspace"))).root;
});
afterEach(async () => { if (server) { await server.app.close(); server.index.close(); } await rm(directory, { recursive: true, force: true }); });
async function boot() { server = await buildApp({ root }); client = createClient(await server.app.listen({ host: "127.0.0.1", port: 0 })); }
async function close() { await server.app.close(); server.index.close(); }
async function wait_for(check: () => Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() >= deadline) throw Error("当前全文输入TCP等待超时"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function observations() {
  const result: Array<{ readonly: boolean; directory: string; files: string[]; number: string; prompt_chars: number; prompt_has_middle: boolean; prompt_has_manual_middle: boolean; manifest: { files: Array<{ file: string; content_hash: string }> } }> = [];
  try { for (const path of await readdir(join(directory, "state"))) { try { for (const line of (await readFile(join(directory, "state", path, "input-observations.jsonl"), "utf8")).trim().split("\n")) result.push(JSON.parse(line)); } catch {} } } catch {}
  return result;
}
async function prepare(protocol: "headless" | "acp") {
  await mkdir(join(root, "cord")); const sandbox = { kind: "workspace", read_paths: [dirname(fixture)], state_dir: join(directory, "state") };
  const agent = protocol === "acp" ? { kind: "acp", bin: process.execPath, args: [fixture, "--acp", "--first-broken", "--require-documents", "--operation", "workflow"], sandbox,
    launch: { mode: "code", option_ids: { mode: "workflow" } }, readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } } }
    : { kind: "headless", bin: process.execPath, prompt_input: "stdin", sandbox, args: [fixture, "--first-broken", "--require-documents", "--operation", "workflow", "--readonly", "{{readonly}}", "-"] };
  await writeFile(join(root, "cord/agents.yaml"), stringify({ agents: { worker: agent } })); await boot();
  const yaml = stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "full-input" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker", output: "text", input_scope: { kind: "dependencies", documents: ["manual.md"] }, require_capabilities: { workspace_isolation: "os_sandbox" }, goal: {
      inputs: ["value.txt", "document-value.txt"], max_attempts: 3, review_changes: true,
      checks: [{ id: "middle-value", bin: process.execPath, args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8')==='fixed'&&fs.readFileSync('document-value.txt','utf8')==='7'?0:3)"] }],
    } } },
    { id: "review", artifact: "findings.md", depends_on: ["deliver"], run: { agent: "worker", readonly: true, output: "text", input_scope: { kind: "dependencies", documents: ["manual.md"] } },
      gates: [{ id: "final-review", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "goal-ready", with: { node_id: "deliver" } }, { ref: "file-nonempty", with: { path: "findings.md" } }], pass: { human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["review"] },
  ] } });
  await client.publishSdlc("full-input", yaml); await client.createRequirement({ req_id, title: "中段完整输入实际交付" }); await client.writeDoc(req_id, "prd", prd);
  await writeFile(join(root, "cord", req_id, "manual.md"), manual);
  const run = (await client.startRun(req_id, { sdlc_id: "full-input" })).run; await wait_for(async () => (await client.getApprovals(req_id)).approvals.length === 1); return run;
}

const native_it = native ? it : it.skip;
describe("当前全文副本的实际TCP交付", () => {
  native_it.each(["headless", "acp"] as const)("%s省略中段实际读取驱动代码/自动修复/只读报告，scope/预算/hash/清理/cold/人审保持", async protocol => {
    const run = await prepare(protocol); const observed = await observations(); expect(observed.map(value => value.readonly)).toEqual([false, false, true]);
    for (const value of observed) {
      expect(value).toMatchObject({ number: "7", prompt_has_middle: false, prompt_has_manual_middle: false }); expect(value.prompt_chars).toBeLessThanOrEqual(60000);
      expect(value.files).not.toContain(value.readonly ? "findings.md" : "review.md"); expect(value.files).not.toContain("events.jsonl");
      expect(value.manifest.files.find(file => file.file === "prd.md")?.content_hash).toBe(sha256Hex(prd));
      await expect(access(value.directory)).rejects.toThrow();
    }
    expect(observed[2]!.files).toContain("review.md"); expect(await readFile(join(root, "document-value.txt"), "utf8")).toBe("7");
    const session = await server.sessions.open(req_id); let facts = await session.events.readOrdered(); expect(facts.filter(event => event.type === "verification.completed").map(event => event.payload["status"])).toEqual(["failed", "passed"]);
    const binding = await server.sdlcs.get("full-input", 1); expect((await readCoordinationExecutionContext(binding.def, session, binding.workflow_revision, server.runs)).goals[0]).toMatchObject({ status: "ready", current: true });
    const round = await client.startCoordination(req_id, { agent: "worker", sdlc_id: "full-input" }); await wait_for(async () => (await client.getCoordination(req_id, round.round.round_id)).round.status === "ok");
    expect((await client.getCoordination(req_id, round.round.round_id)).round.current).toBe(true); expect(await observations()).toHaveLength(3);
    const approval = (await client.getApprovals(req_id)).approvals[0]!; await close(); await boot(); expect(await observations()).toHaveLength(3); expect((await client.getApprovals(req_id)).approvals[0]?.approval_id).toBe(approval.approval_id);
    expect((await server.runs.getRun(run.run_id)).status).toBe("waiting_human"); facts = await (await server.sessions.open(req_id)).events.readOrdered();
    expect(facts.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited" && event.payload["node_id"] !== "deliver")).toHaveLength(0);
    await client.decideApproval(req_id, approval.approval_id, approval.options[0]!); await wait_for(async () => !server.runs.isActive(req_id)); expect((await server.runs.getRun(run.run_id)).status).toBe("completed");
    expect(await observations()).toHaveLength(3); expect((await client.doctor()).ok).toBe(true);
  });
  native_it("上游中段改变后旧人审409，同一run阻断，不以旧副本重新授预算", async () => {
    const run = await prepare("headless"); const approval = (await client.getApprovals(req_id)).approvals[0]!; await close(); await boot();
    await client.writeDoc(req_id, "prd", prd.replace("MID_ONLY_VALUE=7", "MID_ONLY_VALUE=8"));
    await expect(client.decideApproval(req_id, approval.approval_id, approval.options[0]!)).rejects.toMatchObject({ status: 409 }); await wait_for(async () => !server.runs.isActive(req_id));
    expect((await server.runs.getRun(run.run_id)).status).toBe("blocked"); const facts = await (await server.sessions.open(req_id)).events.readOrdered();
    expect((await client.readArtifact(req_id, "findings.md")).content).toContain("INPUT_VALUE_MISMATCH");
    expect(facts.filter(event => event.type === "workflow.run.started")).toHaveLength(1); expect(facts.filter(event => event.type === "goal.attempt.started")).toHaveLength(2);
    expect(facts.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited" && event.payload["node_id"] !== "deliver")).toHaveLength(0);
  });
});
