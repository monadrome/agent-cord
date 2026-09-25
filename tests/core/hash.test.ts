import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { EventEnvelopeSchema, type EventEnvelope } from "../../src/core/schema.js";
import {
  canonicalJson,
  hashChain,
  hashEvent,
  orderEvents,
  sha256Hex,
} from "../../src/core/hash.js";

function buildEvent(
  seq: number,
  overrides: Partial<EventEnvelope> = {},
  payload: unknown = { n: seq },
): EventEnvelope {
  return EventEnvelopeSchema.parse({
    event_id: ulid(),
    session_id: "REQ-TEST",
    seq,
    prev_event_hash: null,
    type: "ledger.entry.proposed",
    schema_version: "1",
    timestamp: new Date(Date.UTC(2026, 8, 24, 0, 0, seq)).toISOString(),
    actor: { kind: "system", id: "test" },
    correlation_id: null,
    payload,
    source: { adapter: "test" },
    ...overrides,
  });
}

describe("hash：规范化 JSON 与哈希", () => {
  it("sha256Hex 与标准向量一致", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("canonicalJson 递归键排序，且与插入顺序无关", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, 2], c: null } });
    const b = canonicalJson({ a: { c: null, d: [3, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[3,2]},"b":1}');
  });

  it("canonicalJson 忽略 undefined 属性、保留数组顺序", () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it("hashEvent 对键序不同的同一事件给出同一哈希", () => {
    const first = buildEvent(1);
    const reordered = {
      source: first.source,
      payload: first.payload,
      correlation_id: first.correlation_id,
      actor: first.actor,
      timestamp: first.timestamp,
      schema_version: first.schema_version,
      type: first.type,
      prev_event_hash: first.prev_event_hash,
      seq: first.seq,
      session_id: first.session_id,
      event_id: first.event_id,
    } as EventEnvelope;
    expect(hashEvent(reordered)).toBe(hashEvent(first));
  });

  it("hashEvent 随内容变化（篡改可见）", () => {
    const first = buildEvent(1);
    const tampered = buildEvent(1, { payload: { n: 999 } });
    expect(hashEvent(tampered)).not.toBe(hashEvent(first));
  });

  it("哈希链对顺序敏感、空流给出确定终值", () => {
    const a = buildEvent(1);
    const b = buildEvent(2, { prev_event_hash: hashEvent(a) });
    expect(hashChain([])).toBe(hashChain([]));
    expect(hashChain([a, b])).not.toBe(hashChain([b, a]));
    expect(hashChain([a, b])).toHaveLength(64);
  });
});

describe("orderEvents：因果拓扑序 + (timestamp, event_id) 兜底", () => {
  it("子事件恒在父事件之后，即便文件行序相反", () => {
    const parent = buildEvent(1);
    const child = buildEvent(2, { prev_event_hash: hashEvent(parent) });
    const ordered = orderEvents([child, parent]);
    expect(ordered.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("跨血统并行事件按 timestamp 兜底排序", () => {
    const root = buildEvent(1, { timestamp: "2026-09-24T00:00:01.000Z" });
    const branchA = buildEvent(2, {
      prev_event_hash: hashEvent(root),
      timestamp: "2026-09-24T00:00:09.000Z",
    });
    const branchB = buildEvent(2, {
      prev_event_hash: hashEvent(root),
      timestamp: "2026-09-24T00:00:05.000Z",
      event_id: "01J9Z3K7AA0000000000000001",
    });
    const ordered = orderEvents([branchA, branchB, root]);
    expect(ordered.map((event) => event.event_id)).toEqual([
      root.event_id,
      branchB.event_id,
      branchA.event_id,
    ]);
  });

  it("prev 指向不存在的事件时视为无前驱，不丢事件", () => {
    const orphan = buildEvent(1, { prev_event_hash: "0".repeat(64) });
    const ordered = orderEvents([orphan]);
    expect(ordered).toHaveLength(1);
  });
});
