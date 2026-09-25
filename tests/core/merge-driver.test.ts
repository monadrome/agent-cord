import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { mergeEventLogs } from "../../src/merge-driver.js";
import { canonicalJson, hashEvent } from "../../src/core/hash.js";
import { EventEnvelopeSchema } from "../../src/core/schema.js";

function event(seq: number, prev_event_hash: string | null, payload: unknown) {
  return EventEnvelopeSchema.parse({
    event_id: ulid(),
    session_id: "REQ-MERGE",
    seq,
    prev_event_hash,
    type: "session.created",
    schema_version: "1",
    timestamp: new Date(Date.UTC(2026, 8, 24, 0, 0, seq)).toISOString(),
    actor: { kind: "system", id: "test" },
    correlation_id: null,
    payload,
    source: { adapter: "test" },
  });
}

describe("cord merge driver", () => {
  it("按 event_id 去重并按因果序合并三路输入", () => {
    const root = event(1, null, { n: 1 });
    const child = event(2, hashEvent(root), { n: 2 });
    const merged = mergeEventLogs([
      { path: "base", text: `${canonicalJson(root)}\n` },
      { path: "ours", text: `${canonicalJson(child)}\n${canonicalJson(root)}\n` },
      { path: "theirs", text: `${canonicalJson(root)}\n${canonicalJson(child)}\n` },
    ]);
    expect(merged.split("\n").filter(Boolean)).toEqual([canonicalJson(root), canonicalJson(child)]);
  });

  it("同 event_id 内容不同则拒绝静默择胜", () => {
    const first = event(1, null, { n: 1 });
    const second = { ...first, payload: { n: 2 } };
    expect(() =>
      mergeEventLogs([
        { path: "ours", text: `${canonicalJson(first)}\n` },
        { path: "theirs", text: `${canonicalJson(second)}\n` },
      ]),
    ).toThrow(/内容不一致/);
  });
});
