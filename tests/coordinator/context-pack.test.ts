/** worker 的实际可见材料、完整预算与失败恢复，不只校验文件 hash。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDriver, AgentTask, SessionHandle } from "../../src/core/ports.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { initSession } from "../../src/core/session.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";
import { readSnapshot } from "../../src/coordinator/snapshot.js";
import { buildContextPack } from "../../src/coordinator/context-pack.js";
import { executionInputHash } from "../../src/coordinator/checkpoint.js";
import { createNodeRunner } from "../../src/coordinator/coordinator.js";

const def: WorkflowDef = { apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "worker-context" }, spec: { nodes: [
  { id: "design", artifact: "design.md", depends_on: [], gates: [] },
  { id: "review", artifact: "review.md", depends_on: [], gates: [] },
  { id: "implement", artifact: "findings.md", depends_on: ["design", "review"], gates: [], run: { agent: "worker", readonly: true, output: "text", retry: { max_attempts: 3, backoff_ms: 0 } } },
] } };
const node = def.spec.nodes[2]!;
const files = ["design.md", "review.md", "findings.md"];
let root: string; let session: SessionHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-worker-context-"));
  session = await initSession(join(root, "cord"), "REQ-WORKER-CONTEXT");
  await writeFile(join(session.dir, "prd.md"), "PRD_HEAD\n" + "p".repeat(40_000) + "\nPRD_LATEST_TAIL");
  await writeFile(join(session.dir, "design.md"), "DESIGN_HEAD\n" + "d".repeat(40_000) + "\nDESIGN_LATEST_TAIL");
  await writeFile(join(session.dir, "review.md"), "# REVIEW_SMALL\n重要的小报告");
  await writeFile(join(session.dir, "adr.md"), "UNRELATED_DOCUMENT_BODY");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function snapshot() {
  const result = await readSnapshot(session, { workflow_id: def.metadata.id, files, excerpt_mode: "head_tail" });
  result.workflow.exited = ["design", "review"];
  return result;
}
function worker() {
  const tasks: AgentTask[] = [];
  const driver: AgentDriver = { name: "worker", async *run(task) { tasks.push(task); yield { type: "result", data: { text: "# 新报告\n本任务完成" } }; }, async *resume() {} };
  return { driver, tasks };
}

describe("worker 上下文覆盖与预算", () => {
  it("受限预算同时覆盖 PRD/上游首尾、小报告与定位符，不加入无关正文", async () => {
    const pack = buildContextPack(def, node, await snapshot(), { maxPackChars: 6_000 });
    expect(pack.length).toBeLessThanOrEqual(6_000);
    for (const marker of ["PRD_HEAD", "PRD_LATEST_TAIL", "DESIGN_HEAD", "DESIGN_LATEST_TAIL", "REVIEW_SMALL"]) expect(pack).toContain(marker);
    expect(pack).not.toContain("UNRELATED_DOCUMENT_BODY");
    expect(pack).toContain("cord/REQ-WORKER-CONTEXT/adr.md");
    const line = pack.split("\n").find((value) => value.startsWith("document_excerpts: "))!;
    const index = JSON.parse(line.slice("document_excerpts: ".length));
    expect(index.map((entry: any) => entry.file)).toEqual(["prd.md", "design.md", "review.md"]);
    expect(index[0].omitted_chars).toBeGreaterThan(0);
  });

  it.each([NaN, Infinity, -1, 100])("非法或不足预算 %s 不派发、不重复重试，调整后可恢复", async (maxPackChars) => {
    const { driver, tasks } = worker();
    const context = { workflow_id: def.metadata.id, node_id: node.id };
    expect(await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root, maxPackChars }).runNode(node, session, context)).toMatchObject({ status: "failed" });
    expect(tasks).toHaveLength(0);
    expect((await session.events.readOrdered()).filter((event) => event.type === "agent.task.completed")).toHaveLength(1);
    expect(await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root, maxPackChars: 6_000 }).runNode(node, session, context)).toMatchObject({ status: "ok" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt.length).toBeLessThanOrEqual(6_000);
    expect(tasks[0]!.prompt).toContain("PRD_LATEST_TAIL");
  });

  it("必需账本或任务说明过大时拒绝构建，不静默截断控制信息", async () => {
    const clean = await snapshot();
    const current = structuredClone(clean);
    current.ledger.push({ entry_id: "large-decision", status: "confirmed", conflict: false, title: "l".repeat(8_000) });
    expect(() => buildContextPack(def, node, current, { maxPackChars: 6_000 })).toThrow();
    const large_task = { ...node, run: { ...node.run!, prompt: "t".repeat(8_000) } };
    expect(() => buildContextPack(def, large_task, clean, { maxPackChars: 6_000 })).toThrow();
  });

  it("宿主源码/重试附记在文档分配之前计入最终预算", async () => {
    const additional_context = "## 源码输入身份\nsource_hash: " + "a".repeat(64) + "\n## 上次尝试失败\n" + "e".repeat(2_000);
    const pack = buildContextPack(def, node, await snapshot(), { maxPackChars: 6_000, additional_context });
    expect(pack.length).toBeLessThanOrEqual(6_000);
    expect(pack).toContain(additional_context);
    expect(pack).toContain("PRD_LATEST_TAIL");
    expect(pack).toContain("REVIEW_SMALL");
  });

  it("原生 worker 的源码绑定与第二次重试 prompt 都保持硬预算，并携带最新尾部", async () => {
    const tasks: AgentTask[] = [];
    const driver: AgentDriver = { name: "retry-worker", async *run(task) {
      tasks.push(task);
      if (tasks.length === 1) yield { type: "error", data: { kind: "agent", message: "RETRY_REASON_" + "e".repeat(2_000) } };
      else yield { type: "result", data: { text: "# 新报告\n重试后完成" } };
    }, async *resume() {} };
    expect(await createNodeRunner(def, { resolveDriver: () => driver, workspaceRoot: root, maxPackChars: 6_000,
      read_source_hash: async () => "a".repeat(64) }).runNode(node, session, { workflow_id: def.metadata.id, node_id: node.id })).toMatchObject({ status: "ok" });
    expect(tasks).toHaveLength(2);
    for (const task of tasks) { expect(task.prompt.length).toBeLessThanOrEqual(6_000); expect(task.prompt).toContain("PRD_LATEST_TAIL"); expect(task.prompt).toContain("source_hash: " + "a".repeat(64)); }
    expect(tasks[1]!.prompt).toContain("RETRY_REASON_");
  });

  it.each([null, "c".repeat(64)])("worker 策略身份拒绝旧前缀 checkpoint（source_hash=%s）", async (source_hash) => {
    const current = await snapshot();
    const legacy = sha256Hex(canonicalJson({ domain: source_hash === null ? "cord.execution-input.v2" : "cord.execution-input.v3",
      ...(source_hash === null ? {} : { source_hash }), agent_configuration_hash: null, workflow: def, node, req_id: current.req_id, title: current.title, max_pack_chars: 60_000,
      docs: current.docs.filter((doc) => doc.file !== node.artifact).map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
      ledger: current.ledger, exited: current.workflow.exited.filter((id) => id !== node.id) }));
    expect(executionInputHash(def, node, current, undefined, null, source_hash)).not.toBe(legacy);
  });
});
