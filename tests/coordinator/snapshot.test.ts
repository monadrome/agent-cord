/** 最新快照与事件批次一致性（ADR-0028），全部使用离线真实 session。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { SessionHandle } from "../../src/core/ports.js";
import { initSession } from "../../src/core/session.js";
import { hashChain } from "../../src/core/hash.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { buildContextPack } from "../../src/coordinator/context-pack.js";
import type { WorkflowDef } from "../../src/core/schema.js";

let root: string;
let session: SessionHandle;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-snapshot-"));
  session = await initSession(join(root, "cord"), "REQ-SNAPSHOT");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function append(type: string, payload: Record<string, unknown>): Promise<void> {
  await session.events.append({
    event_id: ulid(), session_id: session.req_id, type, schema_version: "1",
    actor: { kind: "human", id: "test" }, correlation_id: null, payload, source: { adapter: "test" },
  });
}

async function confirm_entry(): Promise<void> {
  await append("ledger.entry.proposed", {
    entry_id: "C-1", title: "采用最新方案", anchors: [{ kind: "doc", anchor: "prd.md#目标" }],
  });
  await append("ledger.entry.confirmed", { entry_id: "C-1", expected_status: "provisional" });
}

describe("快照一致性", () => {
  it("账本来自最新事件，与 progress/hash 使用同一基线，读取不刷新旧投影文件", async () => {
    const projection_file = join(session.dir, "ledger.yaml");
    const old_projection = await readFile(projection_file, "utf8");
    await confirm_entry();
    await append("workflow.node.exited", { workflow_id: "current", node_id: "design" });
    expect((await session.readLedger()).entries).toEqual([]);

    const snapshot = await readSnapshot(session, { workflow_id: "current" });
    const events = await session.events.readOrdered();
    expect(snapshot.ledger).toContainEqual({ entry_id: "C-1", title: "采用最新方案", status: "confirmed", conflict: false });
    expect(snapshot.workflow.exited).toEqual(["design"]);
    expect(snapshot.event_chain_hash).toBe(hashChain(events));
    expect(snapshot.event_seq).toBe(3);
    expect(await readFile(projection_file, "utf8")).toBe(old_projection);
  });

  it("损坏的磁盘投影不污染事件派生快照，最新推翻立即生效", async () => {
    await confirm_entry();
    await writeFile(join(session.dir, "ledger.yaml"), "invalid ledger projection", "utf8");
    await append("ledger.entry.overturned", { entry_id: "C-1", reason: "需求已变更" });
    const snapshot = await readSnapshot(session);
    expect(snapshot.ledger[0]?.status).toBe("overturned");
    expect(await readFile(join(session.dir, "ledger.yaml"), "utf8")).toBe("invalid ledger projection");
  });

  it("其他 workflow 的同名已退出节点不进入当前进度或上游内容", async () => {
    await append("workflow.node.exited", { workflow_id: "old", node_id: "design" });
    await append("workflow.node.entered", { workflow_id: "current", node_id: "plan" });
    await writeFile(join(session.dir, "design.md"), "OLD_WORKFLOW_CONTENT", "utf8");
    const def: WorkflowDef = {
      apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "current" },
      spec: { nodes: [
        { id: "design", artifact: "design.md", depends_on: [], gates: [] },
        { id: "plan", depends_on: ["design"], gates: [] },
      ] },
    };
    const snapshot = await readSnapshot(session, { workflow_id: "current", files: ["design.md"] });
    expect(snapshot.workflow).toEqual({ entered: ["plan"], exited: [] });
    const pack = buildContextPack(def, def.spec.nodes[1]!, snapshot);
    expect(pack).not.toContain("OLD_WORKFLOW_CONTENT");
    expect(pack).toContain("design.md");
    expect((await readSnapshot(session, { workflow_id: "old" })).snapshot_id).not.toBe(snapshot.snapshot_id);
  });

  it("冲突标记进入快照与上下文，不把 confirmed 冲突当成无异议共识", async () => {
    await confirm_entry();
    await append("ledger.entry.confirmed", { entry_id: "C-1", expected_status: "overturned" });
    const snapshot = await readSnapshot(session);
    expect(snapshot.ledger[0]?.conflict).toBe(true);
    const node = { id: "review", depends_on: [], gates: [] };
    const def: WorkflowDef = {
      apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "review" }, spec: { nodes: [node] },
    };
    expect(buildContextPack(def, node, snapshot)).toContain("冲突");
  });

  it("缺失文档可定位，非普通文件的读取错误不能伪装成缺失", async () => {
    const missing = await readSnapshot(session, { files: ["missing.md"] });
    expect(missing.docs.find((doc) => doc.file === "missing.md")?.exists).toBe(false);
    await mkdir(join(session.dir, "directory.md"));
    await expect(readSnapshot(session, { files: ["directory.md"] })).rejects.toThrow(/普通文件/);
  });
});
