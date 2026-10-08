/** 自定义事件端口的完整性边界与原生严格端口优先级。 */
import { describe, expect, it, vi } from "vitest";
import { readSessionEvents, SessionEventReadError } from "../../src/core/session-events.js";
import type { SessionHandle, EventStore } from "../../src/core/ports.js";
import type { EventEnvelope } from "../../src/core/schema.js";

const event: EventEnvelope = { event_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", session_id: "REQ-PORT", seq: 1, prev_event_hash: null,
  type: "future.event", schema_version: "1", timestamp: "2026-10-08T12:00:00.000Z", actor: { kind: "system", id: "test" },
  correlation_id: null, payload: { unknown: "合法未知 payload" }, source: { adapter: "test" } };
function session(extra: Partial<EventStore> & { diagnostics?: () => { notes: Array<{ kind: string }> } } = {}): SessionHandle {
  return { req_id: "REQ-PORT", dir: "unused", events: {
    append: vi.fn(), readAll: vi.fn(async () => [event]), readOrdered: vi.fn(async () => [event]), subscribe: vi.fn(() => () => {}), ...extra,
  }, readLedger: vi.fn(), rebuildLedger: vi.fn(), doctor: vi.fn() };
}

describe("严格 session 读取", () => {
  it("优先严格端口，历史诊断不代替当前文件读取，未知合法 payload 不被删改", async () => {
    const handle = session({ readOrderedStrict: vi.fn(async () => [event]), diagnostics: () => ({ notes: [{ kind: "unparsable_line" }] }) });
    expect(await readSessionEvents(handle)).toEqual([event]);
    expect(handle.events.readOrdered).not.toHaveBeenCalled();
  });

  it("旧端口合法返回保持兼容，有明确坏行诊断时拒绝", async () => {
    expect(await readSessionEvents(session())).toEqual([event]);
    await expect(readSessionEvents(session({ diagnostics: () => ({ notes: [{ kind: "unparsable_line" }] }) }))).rejects.toBeInstanceOf(SessionEventReadError);
  });

  it.each([{ ...event, seq: -1 }, { ...event, session_id: "REQ-FOREIGN" }])("自定义严格端口的非法返回仍被拒绝", async (invalid) => {
    await expect(readSessionEvents(session({ readOrderedStrict: async () => [invalid] }))).rejects.toBeInstanceOf(SessionEventReadError);
  });

  it("真实 IO 故障不被当作结构错误或空事件流", async () => {
    const failure = new Error("read IO unavailable");
    await expect(readSessionEvents(session({ readOrderedStrict: async () => { throw failure; } }))).rejects.toBe(failure);
  });
});
