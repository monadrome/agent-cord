/** 验证事实消费者必须 fail-closed，不回退旧通过或忽略坏事件。 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSession, type CheckerContext, type SessionHandle } from "../../src/index.js";
import { createVerificationPassedChecker } from "../../src/workflow/checkers.js";

let root: string;
let session: SessionHandle;
const run_id = ulid();
const revision = "a".repeat(64);
const input_hash = "b".repeat(64);
const command_hash = "c".repeat(64);
const checker = createVerificationPassedChecker();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-verification-evidence-"));
  session = await initSession(join(root, "cord"), "REQ-EVIDENCE");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function context(with_session = true, extra: Partial<CheckerContext> = {}): CheckerContext {
  return { session_dir: session.dir, ...(with_session ? { session } : {}), workflow_id: "evidence", workflow_revision: revision,
    run_id, node_id: "verify", input_hash, params: { verification_id: "tests" }, anchors: [], payload: {}, ...extra };
}
async function append(overrides: Record<string, unknown> = {}, correlation_id: string | null = "verify") {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type: "verification.completed", schema_version: "1", actor: { kind: "system", id: "host" }, correlation_id,
    payload: { workflow_id: "evidence", workflow_revision: revision, run_id, node_id: "verify", verification_id: "tests", input_hash, command_hash, status: "passed", exit_code: 0, ...overrides }, source: { adapter: "host" } });
}

describe("机器验证证据有效性", () => {
  it.each([
    { status: "passed", exit_code: 1 }, { command_hash: undefined }, { command_hash: "z".repeat(64) },
    { source_hash: "z".repeat(64) }, { stdout_hash: "z".repeat(64) }, { duration_ms: -1 },
  ])("坏最新结果 %j 阻断门禁，随后合法结果可恢复", async (value) => {
    await append();
    expect((await checker.check(context())).result).toBe("pass");
    await append(value);
    const rejected = await checker.check(context());
    expect(rejected.result).toBe("block");
    expect(rejected.anchors).toEqual([]);
    await append();
    expect((await checker.check(context())).result).toBe("pass");
  });

  it("最新结果的节点 correlation 错误不能跳过并退回历史通过", async () => {
    await append();
    await append({}, "foreign-node");
    expect((await checker.check(context())).result).toBe("block");
    expect((await checker.check(context(true, { params: { verification_id: "tests", within_node: false } }))).result).toBe("pass");
    await append();
    expect((await checker.check(context())).result).toBe("pass");
  });

  it.each([true, false])("损坏整行在 session=%s 读取中阻断，不能忽略后复用旧通过", async (bound) => {
    await append();
    await appendFile(join(session.dir, "events.jsonl"), "INVALID_FAILURE_EVENT\n");
    expect((await checker.check(context(bound))).result).toBe("block");
  });

  it.each([true, false])("其他 session 的合法事件在 session=%s 读取中不可用", async (bound) => {
    const event = await append();
    await writeFile(join(session.dir, "events.jsonl"), JSON.stringify({ ...event, session_id: "REQ-FOREIGN" }) + "\n");
    expect((await checker.check(context(bound))).result).toBe("block");
  });

  it("run 取消事实使通过结果失效，其他 run 取消不污染当前结果", async () => {
    await append();
    const cancel = (id: string) => session.events.append({ event_id: ulid(), session_id: session.req_id, type: "workflow.run.cancelled", schema_version: "1", actor: { kind: "human", id: "test" }, correlation_id: null,
      payload: { workflow_id: "evidence", workflow_revision: revision, run_id: id }, source: { adapter: "test" } });
    await cancel(ulid());
    expect((await checker.check(context())).result).toBe("pass");
    await cancel(run_id);
    expect((await checker.check(context())).result).toBe("block");
  });

  it("读取故障阻断，本次输入修复后不缓存旧失败", async () => {
    await append();
    vi.spyOn(session.events, "readOrderedStrict").mockRejectedValueOnce(new Error("fixture IO"));
    expect((await checker.check(context())).result).toBe("block");
    expect((await checker.check(context())).result).toBe("pass");
  });

  it("当前坏行修复后严格验证读取可恢复，不被历史诊断锁死", async () => {
    await append();
    const path = join(session.dir, "events.jsonl");
    const original = await readFile(path, "utf8");
    await appendFile(path, "INVALID_FAILURE_EVENT\n");
    await session.events.readOrdered();
    expect((await checker.check(context())).result).toBe("block");
    await writeFile(path, original);
    expect((await checker.check(context())).result).toBe("pass");
  });

  it.each([undefined, null, 0])("兼容退出码 %s 未补造为错误", async (exit_code) => {
    await append({ exit_code });
    expect((await checker.check(context())).result).toBe("pass");
  });
});
