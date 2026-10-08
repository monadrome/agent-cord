/** 快照不能消费损坏读取或其他 session 的进度/共识。 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSession, type SessionHandle, type AgentDriver, type WorkflowDef } from "../../src/index.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { createContextSessionAgent } from "../../src/coordinator/session-agent.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";

let root: string;
let session: SessionHandle;
const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "integrity" }, spec: {
  nodes: [{ id: "plan", depends_on: [], gates: [], artifact: "plan.md", run: { agent: "offline", readonly: false } }],
} };
const proposal = { summary: "当前需求明确", next_action: { kind: "advance", node_id: "plan", reason: "可安排计划", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-snapshot-integrity-"));
  session = await initSession(join(root, "cord"), "REQ-INTEGRITY");
  await writeFile(join(session.dir, "prd.md"), "# PRD\n当前需求");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const events_file = () => join(session.dir, "events.jsonl");
async function event(type = "workflow.node.exited") {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "system", id: "test" },
    correlation_id: null, payload: { workflow_id: "integrity", node_id: "plan" }, source: { adapter: "test" } });
}
function worker(): AgentDriver & { calls: number } {
  return { name: "offline", calls: 0, configuration_hash: "a".repeat(64),
    async *run() { this.calls++; yield { type: "result", data: { text: JSON.stringify(proposal) } }; }, async *resume() {} };
}

describe("快照事实完整性", () => {
  it.each(["BROKEN_PRIVATE_WAITING\n", "{\"PRIVATE_PARTIAL_WAITING\":"])("坏完整行/活跃残行 %s 拒绝快照，修复后同句柄恢复", async (line) => {
    await event("workflow.node.entered");
    const baseline = await readFile(events_file(), "utf8");
    await appendFile(events_file(), line);
    await expect(readSnapshot(session)).rejects.toThrow(/事件/);
    await writeFile(events_file(), baseline);
    expect((await readSnapshot(session)).workflow.entered).toEqual(["plan"]);
  });

  it("外部 session 的合法进度不能成为当前节点完成事实", async () => {
    const current = await event();
    await writeFile(events_file(), JSON.stringify({ ...current, session_id: "REQ-FOREIGN" }) + "\n");
    await expect(readSnapshot(session)).rejects.toThrow(/session|需求/);
  });

  it.each(["envelope", "session"])("旧自定义端口返回非法 %s 时仍拒绝快照", async (kind) => {
    const current = await event();
    const legacy: SessionHandle = { ...session, events: {
      append: session.events.append.bind(session.events), readAll: session.events.readAll.bind(session.events), subscribe: session.events.subscribe.bind(session.events),
      readOrdered: async () => [{ ...current, ...(kind === "envelope" ? { seq: -1 } : { session_id: "REQ-FOREIGN" }) }],
    } };
    await expect(readSnapshot(legacy)).rejects.toThrow(/事件|session/);
  });

  it("快照损坏时独立协调和节点 worker 都不派发，修复后新轮次可恢复", async () => {
    const baseline = await readFile(events_file(), "utf8");
    await appendFile(events_file(), "BROKEN_PRIVATE_WAITING\n");
    const driver = worker();
    const options = { resolveDriver: () => driver, workspaceRoot: root };
    expect(await createContextSessionAgent(options).coordinate(def, session, { round_id: ulid(), agent: "offline" })).toMatchObject({ status: "failed", proposal: null });
    const retry_def = structuredClone(def);
    retry_def.spec.nodes[0]!.run!.retry = { max_attempts: 3, backoff_ms: 0 };
    expect(await createNodeRunner(retry_def, options).runNode(retry_def.spec.nodes[0]!, session, { workflow_id: def.metadata.id, node_id: "plan" })).toMatchObject({ status: "failed" });
    expect(driver.calls).toBe(0);
    const recorded = await session.events.readOrdered();
    expect(recorded.filter((item) => item.type === "agent.task.completed")).toHaveLength(1);
    expect(recorded.find((item) => item.type === "agent.task.completed")?.payload).toMatchObject({ retryable: false });
    expect(recorded.filter((item) => item.type.endsWith(".completed")).every((item) => item.payload["failure_stage"] === "snapshot")).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain("BROKEN_PRIVATE_WAITING");
    await writeFile(events_file(), baseline);
    expect((await createContextSessionAgent(options).coordinate(def, session, { round_id: ulid(), agent: "offline" })).status).toBe("ok");
    expect(driver.calls).toBe(1);
  });

  it("模型执行期间出现坏事实不能返回旧提议，修复后重新协调", async () => {
    const driver = worker();
    let changed = false;
    driver.run = async function* () {
      driver.calls++;
      if (!changed) { changed = true; await appendFile(events_file(), "BROKEN_PRIVATE_WAITING\n"); }
      yield { type: "result", data: { text: JSON.stringify(proposal) } };
    };
    const observer = createContextSessionAgent({ resolveDriver: () => driver, workspaceRoot: root });
    expect(await observer.coordinate(def, session, { round_id: ulid(), agent: "offline" })).toMatchObject({ status: "failed", proposal: null });
    const rows = (await readFile(events_file(), "utf8")).split("\n").filter((row) => row !== "BROKEN_PRIVATE_WAITING").join("\n");
    await writeFile(events_file(), rows);
    expect((await session.events.readOrdered()).find((item) => item.type === "coordinator.round.completed")?.payload).toMatchObject({ failure_stage: "freshness" });
    expect((await observer.coordinate(def, session, { round_id: ulid(), agent: "offline" })).status).toBe("ok");
  });
});
