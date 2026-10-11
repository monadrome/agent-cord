import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSession, createNodeRunner, type AgentCapabilities, type AgentDriver, type SessionHandle, type WorkflowDef } from "../../src/index.js";
import { buildCoordinationPrompt, parseCoordinationProposal } from "../../src/coordinator/session-agent.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";

let root: string; let session: SessionHandle;
const caps: AgentCapabilities = { transport: "headless", evidence: "adapter", installation: "unchecked", prompt_input: "stdin", workspace_isolation: "shared_lease", launch_options: ["model"], native_resume: "supported", readonly_launch: "mapped", readonly_resume: "supported", goal: "host", workflow_resume: "authorized_unexited_goal" };
const def = (require_capabilities?: Record<string, string>): WorkflowDef => ({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "capability-requirements" }, spec: { nodes: [{ id: "review", artifact: "review.md", depends_on: [], run: { agent: "worker", readonly: true, output: "text", ...(require_capabilities === undefined ? {} : { require_capabilities }) }, gates: [] }] } });
const proposal = { summary: "推进当前评审", next_action: { kind: "advance", node_id: "review", reason: "能力满足", evidence: [{ source: "workflow", id: "review" }] }, risks: [] } as const;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-capability-requirements-")); session = await initSession(join(root, "cord"), "REQ-CAPABILITY"); await writeFile(join(session.dir, "prd.md"), "# 最新需求\n能力准入"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Workflow Agent能力准入", () => {
  it.each([
    { field: "prompt_input", value: "stdin" }, { field: "native_resume", value: "supported" }, { field: "workspace_isolation", value: "shared_lease" }, { field: "transport", value: "headless" },
  ])("满足能力要求%s可推进，变化或缺失只能wait且不调用driver", async ({ field, value }) => {
    const workflow = def({ [field]: value }); const snapshot = await readSnapshot(session, { workflow_id: workflow.metadata.id });
    const agents = [{ agent: "worker", resolution: "resolved" as const, configuration_hash: "a".repeat(64), capabilities: caps }];
    expect(buildCoordinationPrompt(workflow, snapshot, undefined, null, [], undefined, undefined, agents)).toContain('eligible_nodes: ["review"]');
    expect(parseCoordinationProposal(JSON.stringify(proposal), workflow, snapshot, [], undefined, undefined, agents)).toEqual(proposal);
    const mismatch = structuredClone(caps); (mismatch as Record<string, unknown>)[field] = field === "workspace_isolation" ? "worktree" : field === "prompt_input" ? "argv" : field === "transport" ? "acp" : "unsupported";
    const missing = [{ ...agents[0]!, capabilities: null }];
    expect(buildCoordinationPrompt(workflow, snapshot, undefined, null, [], undefined, undefined, [{ ...agents[0]!, capabilities: mismatch as AgentCapabilities }])).toContain("eligible_nodes: []");
    expect(() => parseCoordinationProposal(JSON.stringify(proposal), workflow, snapshot, [], undefined, undefined, [{ ...agents[0]!, capabilities: mismatch as AgentCapabilities }])).toThrow(/不可推进/);
    let calls = 0; const driver: AgentDriver = { name: "worker", configuration_hash: "a".repeat(64), capabilities: mismatch as AgentCapabilities, async *run() { calls++; yield { type: "result", data: { text: "不应派发" } }; }, async *resume() {} };
    const runner = createNodeRunner(workflow, { workspaceRoot: root, resolveDriver: () => driver });
    expect(await runner.runNode(workflow.spec.nodes[0]!, session, { workflow_id: workflow.metadata.id, node_id: "review" })).toMatchObject({ status: "failed", retryable: false }); expect(calls).toBe(0);
    expect(missing).toHaveLength(1);
  });

  it("默认节点没有require_capabilities时保持兼容", async () => {
    const workflow = def(); const snapshot = await readSnapshot(session, { workflow_id: workflow.metadata.id });
    const agents = [{ agent: "worker", resolution: "resolved" as const, configuration_hash: "a".repeat(64), capabilities: null }];
    expect(buildCoordinationPrompt(workflow, snapshot, undefined, null, [], undefined, undefined, agents)).toContain('eligible_nodes: ["review"]');
  });
});
