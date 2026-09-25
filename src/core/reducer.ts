/**
 * createReducer：events.jsonl → ledger.yaml 的确定性纯函数投影（ADR-0020 决策 4/5）。
 *
 * - 纯函数：同输入同输出，不读时钟与随机数；
 * - 条件写入：状态流转事件的 payload 带 expected_status（或 based_on 事件哈希），
 *   与当前投影不符时**不静默择胜**，只把该条目 conflict 置 true（ADR-0020 决策 5）；
 * - 非法流转（跳级、终态再变）同样按冲突处理；
 * - unknown 事件类型忽略（事件类型是闭合目录，新增走 ADR）。
 */
import type { Reducer } from "./ports.js";
import {
  AnchorSchema,
  LedgerEntrySchema,
  LedgerSchema,
  LedgerStatusSchema,
  type Anchor,
  type EventEnvelope,
  type Ledger,
  type LedgerEntry,
  type LedgerStatus,
} from "./schema.js";
import { canonicalJson, hashChain, hashEvent, orderEvents, sha256Hex } from "./hash.js";

/** reducer 版本（变更走 ADR；须向后兼容回放，ADR-0020 注意点 4） */
export const REDUCER_VERSION = "1";

const CONFIDENCE_SOURCES = ["vote_agreement", "human_confirmation", "evidence_direct"] as const;
type ConfidenceSource = (typeof CONFIDENCE_SOURCES)[number];

interface EntryState {
  entry: LedgerEntry;
  /** 最近一条真正改变该条目的事件哈希（based_on 的比对基准） */
  last_event_hash: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asConfidenceSource(value: unknown): ConfidenceSource | null {
  return CONFIDENCE_SOURCES.find((source) => source === value) ?? null;
}

function parseAnchors(value: unknown): Anchor[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const anchors: Anchor[] = [];
  for (const item of value) {
    const parsed = AnchorSchema.safeParse(item);
    if (!parsed.success) return null;
    anchors.push(parsed.data);
  }
  return anchors;
}

/** 条件写入校验：expected_status（当前状态）与 based_on（该条目最新事件哈希） */
function preconditionHolds(payload: Record<string, unknown>, state: EntryState): boolean {
  const expected = payload["expected_status"];
  if (expected !== undefined && expected !== null) {
    const parsed = LedgerStatusSchema.safeParse(expected);
    if (!parsed.success || parsed.data !== state.entry.status) return false;
  }
  const basedOn = payload["based_on"];
  if (basedOn !== undefined && basedOn !== null) {
    if (typeof basedOn !== "string" || basedOn !== state.last_event_hash) return false;
  }
  return true;
}

function markConflict(state: EntryState, event: EventEnvelope): void {
  state.entry = { ...state.entry, conflict: true };
  state.last_event_hash = hashEvent(event);
}

function completeEntry(fields: Record<string, unknown>): LedgerEntry | null {
  const parsed = LedgerEntrySchema.safeParse(fields);
  return parsed.success ? parsed.data : null;
}

/** proposed：payload.entry.{entry_id,title,anchors}（兼容平铺字段与 docs/04 §6.2 的形态） */
function applyProposed(
  entries: Map<string, EntryState>,
  order: string[],
  event: EventEnvelope,
): void {
  const payload = asRecord(event.payload);
  if (!payload) return;
  const raw = asRecord(payload["entry"]) ?? payload;

  const entryId = asNonEmptyString(raw["entry_id"]) ?? asNonEmptyString(raw["entryId"]);
  if (entryId === null) return;
  const title = asNonEmptyString(raw["title"]);
  const anchors = parseAnchors(raw["anchors"]);
  if (title === null || anchors === null) {
    const existing = entries.get(entryId);
    if (existing) markConflict(existing, event);
    return;
  }

  const proposed = completeEntry({
    entry_id: entryId,
    title,
    anchors,
    // 入账默认 provisional（04 章 §3.3：临时身份默认），confidence_source 只是「凭什么信它」
    status: "provisional",
    confidence_source: asConfidenceSource(raw["confidence_source"]) ?? "evidence_direct",
    vote_record_id: asNullableString(raw["vote_record_id"]),
    superseded_by: null,
    overturn_reason: null,
    conflict: false,
  });
  if (proposed === null) return;

  const existing = entries.get(entryId);
  if (!existing) {
    entries.set(entryId, { entry: proposed, last_event_hash: hashEvent(event) });
    order.push(entryId);
    return;
  }
  if (sameEntryIdentity(existing.entry, proposed)) return; // 内容相同的重复提议：幂等空操作
  markConflict(existing, event); // 同 id 不同内容：不覆盖，转冲突
}

function sameEntryIdentity(a: LedgerEntry, b: LedgerEntry): boolean {
  return a.title === b.title && canonicalJson(a.anchors) === canonicalJson(b.anchors);
}

type TransitionTarget = "confirmed" | "overturned" | "drifted";

function applyTransition(
  entries: Map<string, EntryState>,
  event: EventEnvelope,
  target: TransitionTarget,
): void {
  const payload = asRecord(event.payload);
  if (!payload) return;
  const entryId = asNonEmptyString(payload["entry_id"]);
  if (entryId === null) return;
  const state = entries.get(entryId);
  if (!state) return; // 引用不存在的条目：无可冲突对象，忽略

  if (!preconditionHolds(payload, state)) {
    markConflict(state, event);
    return;
  }

  const status = state.entry.status;
  if (target === "confirmed") {
    if (status === "overturned") {
      markConflict(state, event); // 终态不可复活
      return;
    }
    const confidenceSource = asConfidenceSource(payload["confidence_source"]);
    const voteRecordId = asNullableString(payload["vote_record_id"]);
    const anchors = parseAnchors(payload["anchors"]);
    const updated: LedgerEntry = {
      ...state.entry,
      status: "confirmed",
      confidence_source: confidenceSource ?? state.entry.confidence_source,
      vote_record_id: voteRecordId ?? state.entry.vote_record_id,
      anchors: anchors ?? state.entry.anchors,
    };
    commit(state, updated, event);
    return;
  }

  if (target === "overturned") {
    if (status !== "confirmed") {
      markConflict(state, event); // provisional→overturned 是跳级；overturned 之后再变是非法
      return;
    }
    const updated: LedgerEntry = {
      ...state.entry,
      status: "overturned",
      overturn_reason:
        asNonEmptyString(payload["reason"]) ??
        asNonEmptyString(payload["overturn_reason"]) ??
        state.entry.overturn_reason,
      superseded_by: asNullableString(payload["superseded_by"]) ?? state.entry.superseded_by,
    };
    commit(state, updated, event);
    return;
  }

  // anchor_drifted：机器触发的降级（confirmed → provisional，04 章 §3.2 的唯一回退例外）
  if (status === "overturned") {
    markConflict(state, event);
    return;
  }
  if (status === "provisional") return; // 已是目标状态：幂等空操作
  commit(state, { ...state.entry, status: "provisional" }, event);
}

function commit(state: EntryState, entry: LedgerEntry, event: EventEnvelope): void {
  const normalized = completeEntry({ ...entry });
  if (normalized === null) return;
  if (canonicalJson(normalized) === canonicalJson(state.entry)) return; // 无变化则不动基准
  state.entry = normalized;
  state.last_event_hash = hashEvent(event);
}

export function reduceEvents(events: readonly EventEnvelope[]): Ledger {
  const ordered = orderEvents(events);
  const entries = new Map<string, EntryState>();
  const order: string[] = [];

  for (const event of ordered) {
    switch (event.type) {
      case "ledger.entry.proposed":
        applyProposed(entries, order, event);
        break;
      case "ledger.entry.confirmed":
        applyTransition(entries, event, "confirmed");
        break;
      case "ledger.entry.overturned":
        applyTransition(entries, event, "overturned");
        break;
      case "ledger.entry.anchor_drifted":
        applyTransition(entries, event, "drifted");
        break;
      default:
        break; // unknown 事件类型忽略
    }
  }

  const projected: LedgerEntry[] = [];
  for (const entryId of order) {
    const state = entries.get(entryId);
    if (state) projected.push(state.entry);
  }

  return LedgerSchema.parse({
    reducer_version: REDUCER_VERSION,
    input_hash: hashChain(ordered),
    output_hash: sha256Hex(canonicalJson(projected)),
    entries: projected,
  });
}

export function createReducer(): Reducer {
  return {
    version: REDUCER_VERSION,
    reduce: (events): Ledger => reduceEvents(events),
  };
}
