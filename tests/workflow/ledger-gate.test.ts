/** 最新共识门禁：不读取滞后投影，不以冲突条目放行（ADR-0029）。 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { initSession } from "../../src/core/session.js";
import type { CheckerContext, SessionHandle } from "../../src/core/ports.js";
import type { WorkflowDef } from "../../src/core/schema.js";
import { createLedgerHasConfirmedChecker } from "../../src/workflow/checkers.js";
import { createExecutor } from "../../src/workflow/executor.js";

let root: string;
let session: SessionHandle;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-ledger-gate-"));
  session = await initSession(join(root, "cord"), "REQ-LEDGER");
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function context(payload: Record<string, unknown> = {}, with_session = true): CheckerContext {
  return { session_dir: session.dir, anchors: [], payload, ...(with_session ? { session } : {}) };
}

async function append(type: string, payload: Record<string, unknown>): Promise<void> {
  await session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null, payload, source: { adapter: "test" } });
}

async function confirm(): Promise<void> {
  await append("ledger.entry.proposed", { entry_id: "C-1", title: "最新共识", anchors: [{ kind: "doc", anchor: "prd.md" }] });
  await append("ledger.entry.confirmed", { entry_id: "C-1" });
}

describe("最新 ledger 门禁", () => {
  it("最新确认立即放行，不要求刷新磁盘投影", async () => {
    const before = await readFile(join(session.dir, "ledger.yaml"), "utf8");
    await confirm();
    expect((await createLedgerHasConfirmedChecker().check(context())).result).toBe("pass");
    expect(await readFile(join(session.dir, "ledger.yaml"), "utf8")).toBe(before);
  });

  it("推翻立即阻断，旧投影中的 confirmed 不能继续放行", async () => {
    await confirm();
    await session.rebuildLedger();
    await append("ledger.entry.overturned", { entry_id: "C-1", reason: "需求变更" });
    expect((await session.readLedger()).entries[0]?.status).toBe("confirmed");
    expect((await createLedgerHasConfirmedChecker().check(context())).result).toBe("block");
  });

  it("confirmed 但 conflict=true 的条目不能作为门禁证据", async () => {
    await confirm();
    await append("ledger.entry.confirmed", { entry_id: "C-1", expected_status: "overturned" });
    await session.rebuildLedger();
    const result = await createLedgerHasConfirmedChecker().check(context({ entry_id: "C-1" }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("冲突");
  });

  it.each([7, null, ""])("entry_id=%s 非法时不能扩大为任意 confirmed 条目", async (entry_id) => {
    await confirm();
    await session.rebuildLedger();
    expect((await createLedgerHasConfirmedChecker().check(context({ entry_id }))).result).toBe("block");
  });

  it("无 session 的默认目录读取从事件投影，损坏账本不会污染判定", async () => {
    await confirm();
    await writeFile(join(session.dir, "ledger.yaml"), "not a ledger", "utf8");
    expect((await createLedgerHasConfirmedChecker().check(context({}, false))).result).toBe("pass");
  });

  it("事件格式损坏时默认目录读取 fail-closed，不回退旧 confirmed 投影", async () => {
    await confirm();
    await session.rebuildLedger();
    await appendFile(join(session.dir, "events.jsonl"), "INVALID_EVENT\n", "utf8");
    const result = await createLedgerHasConfirmedChecker().check(context({}, false));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("fail-closed");
  });

  it("已绑定 session 的读侧诊断发现损坏整行时同样阻断", async () => {
    await confirm();
    await session.rebuildLedger();
    await appendFile(join(session.dir, "events.jsonl"), "INVALID_EVENT\n", "utf8");
    const result = await createLedgerHasConfirmedChecker().check(context());
    expect(result.result).toBe("block");
    expect(result.reason).toContain("无法解析");
  });

  it("默认目录读取拒绝其他 session 的有效事件", async () => {
    await confirm();
    const events = await session.events.readOrdered();
    await writeFile(join(session.dir, "events.jsonl"), events.map((event) => JSON.stringify({ ...event, session_id: "REQ-FOREIGN" })).join("\n") + "\n");
    const result = await createLedgerHasConfirmedChecker().check(context({}, false));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("其他 session");
  });

  it("已绑定 session 也不能把外部 session 的事件作为本需求证据", async () => {
    await confirm();
    const events = await session.events.readOrdered();
    await writeFile(join(session.dir, "events.jsonl"), events.map((event) => JSON.stringify({ ...event, session_id: "REQ-FOREIGN" })).join("\n") + "\n");
    const result = await createLedgerHasConfirmedChecker().check(context());
    expect(result.result).toBe("block");
    expect(result.reason).toContain("其他 session");
  });

  it("ctx.session 优先于注册表绑定，显式投影 adapter 仍支持且做契约校验", async () => {
    await confirm();
    const other = await initSession(join(root, "cord"), "REQ-OTHER");
    expect((await createLedgerHasConfirmedChecker({ session: other }).check(context())).result).toBe("pass");
    const projection = await session.rebuildLedger();
    expect((await createLedgerHasConfirmedChecker({ readLedger: async () => projection }).check(context({}, false))).result).toBe("pass");
    const malformed = { ...projection, entries: [{ ...projection.entries[0], status: "INVALID" }] };
    expect((await createLedgerHasConfirmedChecker({ readLedger: async () => malformed as typeof projection }).check(context({}, false))).result).toBe("block");
  });

  it("事件读取暂时失败时 block，恢复后再次判定不使用缓存结果", async () => {
    await confirm();
    await session.rebuildLedger();
    vi.spyOn(session.events, "readOrdered").mockRejectedValueOnce(new Error("event read IO unavailable"));
    const checker = createLedgerHasConfirmedChecker();
    expect((await checker.check(context())).result).toBe("block");
    expect((await checker.check(context())).result).toBe("pass");
  });

  it("被 gate 阻断后追加确认，再运行可恢复，节点只退出一次", async () => {
    const def: WorkflowDef = {
      apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "latest-gate" },
      spec: { nodes: [{ id: "review", depends_on: [], gates: [{
        id: "consensus", role: { initiators: [], approvers: [] }, attach: { node: "review", when: "post", triggers: [] },
        checks: [{ ref: "ledger-has-confirmed" }], pass: { require: "all", human_confirm: false }, on_fail: "block", write_back: [],
      }] }] },
    };
    const executor = createExecutor({ humanGate: { ask: async () => { throw new Error("无需人工分支"); } } });
    await executor.run(def, session);
    expect((await session.events.readOrdered()).some((event) => event.type === "workflow.node.exited")).toBe(false);
    await confirm();
    await executor.run(def, session);
    expect((await session.events.readOrdered()).filter((event) => event.type === "workflow.node.exited")).toHaveLength(1);
  });
});
