import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { createReducer, REDUCER_VERSION } from "../../src/core/reducer.js";
import { canonicalJson, hashEvent, sha256Hex } from "../../src/core/hash.js";
import {
  EventEnvelopeSchema,
  LedgerSchema,
  type Anchor,
  type EventEnvelope,
  type Ledger,
  type LedgerEntry,
} from "../../src/core/schema.js";

const SESSION = "REQ-TEST";
const ANCHOR: Anchor = { kind: "code", anchor: "src/x.ts#f" };

function envelope(seq: number, type: string, payload: unknown, prev: string | null): EventEnvelope {
  return EventEnvelopeSchema.parse({
    event_id: ulid(),
    session_id: SESSION,
    seq,
    prev_event_hash: prev,
    type,
    schema_version: "1",
    timestamp: new Date(Date.UTC(2026, 8, 24, 0, 0, seq)).toISOString(),
    actor: { kind: "system", id: "test" },
    correlation_id: null,
    payload,
    source: { adapter: "test" },
  });
}

/** 构造一条合法的因果链（prev 环环相扣） */
function chain(specs: Array<{ type: string; payload: unknown }>): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let prev: string | null = null;
  specs.forEach((spec, index) => {
    const event = envelope(index + 1, spec.type, spec.payload, prev);
    prev = hashEvent(event);
    events.push(event);
  });
  return events;
}

function propose(entryId = "C-001", title = "title", anchors: Anchor[] = [ANCHOR]) {
  return { entry: { entry_id: entryId, title, anchors } };
}

function reduce(events: EventEnvelope[]): Ledger {
  return createReducer().reduce(events);
}

function entryOf(ledger: Ledger, entryId: string): LedgerEntry {
  const found = ledger.entries.find((item) => item.entry_id === entryId);
  if (!found) throw new Error(`缺少条目 ${entryId}`);
  return found;
}

describe("reducer：状态机全路径", () => {
  it("proposed → provisional，并保留锚点", () => {
    const ledger = reduce(chain([{ type: "ledger.entry.proposed", payload: propose() }]));
    const entry = entryOf(ledger, "C-001");
    expect(entry.status).toBe("provisional");
    expect(entry.conflict).toBe(false);
    expect(entry.title).toBe("title");
    expect(entry.anchors).toEqual([ANCHOR]);
    expect(entry.vote_record_id).toBeNull();
    expect(entry.superseded_by).toBeNull();
    expect(ledger.reducer_version).toBe(REDUCER_VERSION);
  });

  it("provisional → confirmed →（锚点失效）provisional → 重验 confirmed → overturned", () => {
    const ledger = reduce(
      chain([
        { type: "ledger.entry.proposed", payload: propose() },
        {
          type: "ledger.entry.confirmed",
          payload: {
            entry_id: "C-001",
            expected_status: "provisional",
            confidence_source: "vote_agreement",
            vote_record_id: "V-0001",
          },
        },
        { type: "ledger.entry.anchor_drifted", payload: { entry_id: "C-001", anchor_id: "A-1" } },
        {
          type: "ledger.entry.confirmed",
          payload: { entry_id: "C-001", expected_status: "provisional" },
        },
        {
          type: "ledger.entry.overturned",
          payload: {
            entry_id: "C-001",
            expected_status: "confirmed",
            reason: "requirement_change",
            superseded_by: "C-002",
          },
        },
      ]),
    );
    const entry = entryOf(ledger, "C-001");
    expect(entry.status).toBe("overturned");
    expect(entry.conflict).toBe(false);
    expect(entry.confidence_source).toBe("vote_agreement");
    expect(entry.vote_record_id).toBe("V-0001");
    expect(entry.overturn_reason).toBe("requirement_change");
    expect(entry.superseded_by).toBe("C-002");
  });

  it("anchor_drifted 作用于 provisional 是幂等空操作，作用于 overturned 是冲突", () => {
    const applyDrifted = (prefix: Array<{ type: string; payload: unknown }>) =>
      entryOf(
        reduce(chain([...prefix, { type: "ledger.entry.anchor_drifted", payload: { entry_id: "C-001" } }])),
        "C-001",
      );
    expect(applyDrifted([{ type: "ledger.entry.proposed", payload: propose() }]).conflict).toBe(false);
    const overturned = applyDrifted([
      { type: "ledger.entry.proposed", payload: propose() },
      { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
      { type: "ledger.entry.overturned", payload: { entry_id: "C-001", expected_status: "confirmed" } },
    ]);
    expect(overturned.status).toBe("overturned");
    expect(overturned.conflict).toBe(true);
  });
});

describe("reducer：条件写入（不静默择胜）", () => {
  it("expected_status 与当前状态不符时：不改状态、只置 conflict", () => {
    const ledger = reduce(
      chain([
        { type: "ledger.entry.proposed", payload: propose() },
        {
          type: "ledger.entry.confirmed",
          payload: { entry_id: "C-001", expected_status: "overturned" },
        },
      ]),
    );
    const entry = entryOf(ledger, "C-001");
    expect(entry.status).toBe("provisional");
    expect(entry.conflict).toBe(true);
  });

  it("重验通过的事件到达时条目已被推翻：不复活，置 conflict", () => {
    const ledger = reduce(
      chain([
        { type: "ledger.entry.proposed", payload: propose() },
        {
          type: "ledger.entry.confirmed",
          payload: { entry_id: "C-001", expected_status: "provisional" },
        },
        {
          type: "ledger.entry.overturned",
          payload: { entry_id: "C-001", expected_status: "confirmed", reason: "insufficient_evidence" },
        },
        {
          type: "ledger.entry.confirmed",
          payload: { entry_id: "C-001", expected_status: "provisional" },
        },
      ]),
    );
    const entry = entryOf(ledger, "C-001");
    expect(entry.status).toBe("overturned");
    expect(entry.conflict).toBe(true);
  });

  it("based_on 指向非最新事件（过期读）时置 conflict", () => {
    const [proposal] = chain([{ type: "ledger.entry.proposed", payload: propose() }]);
    const proposalHash = hashEvent(proposal!);
    const events = chain([
      { type: "ledger.entry.proposed", payload: propose() },
      { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
      {
        type: "ledger.entry.overturned",
        payload: { entry_id: "C-001", based_on: proposalHash, reason: "requirement_change" },
      },
    ]);
    const entry = entryOf(reduce(events), "C-001");
    expect(entry.status).toBe("confirmed");
    expect(entry.conflict).toBe(true);
  });

  it("based_on 指向最新事件时正常流转", () => {
    const events = chain([
      { type: "ledger.entry.proposed", payload: propose() },
      { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
    ]);
    const confirmedHash = hashEvent(events[1]!);
    events.push(
      envelope(3, "ledger.entry.overturned", { entry_id: "C-001", based_on: confirmedHash }, confirmedHash),
    );
    const entry = entryOf(reduce(events), "C-001");
    expect(entry.status).toBe("overturned");
    expect(entry.conflict).toBe(false);
  });
});

describe("reducer：非法流转按冲突处理", () => {
  it("provisional → overturned（跳级）置 conflict，状态不变", () => {
    const entry = entryOf(
      reduce(
        chain([
          { type: "ledger.entry.proposed", payload: propose() },
          { type: "ledger.entry.overturned", payload: { entry_id: "C-001", expected_status: "provisional" } },
        ]),
      ),
      "C-001",
    );
    expect(entry.status).toBe("provisional");
    expect(entry.conflict).toBe(true);
  });

  it("overturned 之后再变（再次推翻）置 conflict，状态不变", () => {
    const entry = entryOf(
      reduce(
        chain([
          { type: "ledger.entry.proposed", payload: propose() },
          { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
          { type: "ledger.entry.overturned", payload: { entry_id: "C-001", expected_status: "confirmed" } },
          { type: "ledger.entry.overturned", payload: { entry_id: "C-001", expected_status: "overturned" } },
        ]),
      ),
      "C-001",
    );
    expect(entry.status).toBe("overturned");
    expect(entry.conflict).toBe(true);
  });
});

describe("reducer：幂等、忽略与确定性", () => {
  it("合并重复 event_id 不会把同一事实第二次应用成冲突", () => {
    const events = chain([
      { type: "ledger.entry.proposed", payload: propose() },
      { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
    ]);
    const duplicate = { ...events[1]! };
    const ledger = reduce([...events, duplicate]);
    expect(entryOf(ledger, "C-001").status).toBe("confirmed");
    expect(entryOf(ledger, "C-001").conflict).toBe(false);
  });

  it("内容相同的重复提议是幂等空操作，内容不同则冲突（不覆盖）", () => {
    const idempotent = entryOf(
      reduce(
        chain([
          { type: "ledger.entry.proposed", payload: propose() },
          { type: "ledger.entry.proposed", payload: propose() },
        ]),
      ),
      "C-001",
    );
    expect(idempotent.title).toBe("title");
    expect(idempotent.conflict).toBe(false);

    const conflicting = entryOf(
      reduce(
        chain([
          { type: "ledger.entry.proposed", payload: propose() },
          { type: "ledger.entry.proposed", payload: propose("C-001", "另一个标题", [ANCHOR]) },
        ]),
      ),
      "C-001",
    );
    expect(conflicting.title).toBe("title");
    expect(conflicting.conflict).toBe(true);
  });

  it("unknown 事件类型、坏 payload、不存在的 entry_id 一律忽略且不抛错", () => {
    const ledger = reduce(
      chain([
        { type: "vote.completed", payload: { entry_id: "C-001", vote_id: "V-1" } },
        { type: "gate.resolved", payload: {} },
        { type: "ledger.entry.proposed", payload: { entry: { entry_id: "C-001" } } },
        { type: "ledger.entry.confirmed", payload: { entry_id: "C-999" } },
        { type: "ledger.entry.confirmed", payload: "not-an-object" },
        { type: "ledger.entry.proposed", payload: propose() },
      ]),
    );
    expect(ledger.entries).toHaveLength(1);
    expect(entryOf(ledger, "C-001").status).toBe("provisional");
    expect(entryOf(ledger, "C-001").conflict).toBe(false);
  });

  it("兼容 docs/04 §6.2 的平铺 payload 形态，且入账一律 provisional", () => {
    const ledger = reduce(
      chain([
        {
          type: "ledger.entry.proposed",
          payload: { entry_id: "C-007", title: "平铺形态", status: "confirmed", anchors: [ANCHOR] },
        },
      ]),
    );
    const entry = entryOf(ledger, "C-007");
    expect(entry.status).toBe("provisional");
    expect(LedgerSchema.safeParse(ledger).success).toBe(true);
  });

  it("同输入同输出：事件乱序传入不改结果；input_hash 覆盖事件流、output_hash 覆盖 entries", () => {
    const events = chain([
      { type: "ledger.entry.proposed", payload: propose() },
      { type: "ledger.entry.proposed", payload: propose("C-002", "第二条", [ANCHOR]) },
      { type: "ledger.entry.confirmed", payload: { entry_id: "C-001", expected_status: "provisional" } },
    ]);
    const straight = reduce(events);
    const shuffled = reduce([events[2]!, events[0]!, events[1]!]);
    expect(canonicalJson(shuffled)).toBe(canonicalJson(straight));
    expect(shuffled.output_hash).toBe(sha256Hex(canonicalJson(straight.entries)));
    expect(straight.input_hash).toHaveLength(64);

    const extra = reduce([...events, envelope(4, "session.created", {}, hashEvent(events[2]!))]);
    expect(extra.input_hash).not.toBe(straight.input_hash);
    expect(extra.output_hash).toBe(straight.output_hash);
  });
});
