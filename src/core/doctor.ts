/**
 * runDoctor：事件流与投影的对账（ADR-0020 注意点 5、04 章 §6.4）。
 *
 * ① event_id 全局唯一；
 * ② 按 prev_event_hash 建链，每个血统内 seq 严格递增无空洞（跨血统交错合法）；
 * ③ 每个事件的 prev_event_hash 指向存在的事件（首事件 null）——前驱链完整 + 篡改可见；
 * ④ reducer 重放结果与 ledger.yaml 一致（不一致可 rebuildLedger 重建）。
 *
 * 只诊断、不修复：修复属于写路径（rebuildLedger / merge driver），doctor 不做隐式写入。
 */
import type { DoctorReport, SessionHandle } from "./ports.js";
import type { EventEnvelope, Ledger } from "./schema.js";
import { canonicalJson, hashEvent } from "./hash.js";
import { createReducer } from "./reducer.js";
import type { EventStoreNote, EventStoreDiagnostics } from "./store.js";

interface EventStoreDiagnosticsReader {
  diagnostics(): EventStoreDiagnostics;
}

const MAX_DETAIL_ITEMS = 5;

function summarize(items: string[]): string {
  if (items.length <= MAX_DETAIL_ITEMS) return items.join("; ");
  return `${items.slice(0, MAX_DETAIL_ITEMS).join("; ")}; 等共 ${items.length} 处`;
}

type Check = DoctorReport["checks"][number];

function checkEventIdUnique(events: readonly EventEnvelope[]): Check {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (seen.has(event.event_id)) duplicates.add(event.event_id);
    seen.add(event.event_id);
  }
  return {
    name: "event_id_unique",
    ok: duplicates.size === 0,
    detail:
      duplicates.size === 0
        ? `${events.length} 个事件，event_id 全局唯一`
        : `event_id 重复：${summarize([...duplicates])}`,
  };
}

function checkPrevChain(events: readonly EventEnvelope[]): Check {
  const hashes = new Set(events.map((event) => hashEvent(event)));
  const broken: string[] = [];
  for (const event of events) {
    if (event.prev_event_hash === null) continue;
    if (!hashes.has(event.prev_event_hash)) {
      broken.push(
        `seq ${event.seq}(${event.event_id}) 的 prev_event_hash 无对应事件（前驱被删或被改写）`,
      );
    }
  }
  return {
    name: "prev_event_hash_chain",
    ok: broken.length === 0,
    detail:
      broken.length === 0
        ? `${events.length} 个事件的前驱链完整（首事件 prev_event_hash 为 null）`
        : `前驱链断裂：${summarize(broken)}`,
  };
}

function checkLineageSeq(events: readonly EventEnvelope[], notes: readonly EventStoreNote[]): Check {
  const byHash = new Map<string, EventEnvelope>();
  for (const event of events) {
    const hash = hashEvent(event);
    if (!byHash.has(hash)) byHash.set(hash, event);
  }

  const violations: string[] = [];
  let linked = 0;
  for (const event of events) {
    if (event.prev_event_hash === null) continue;
    const parent = byHash.get(event.prev_event_hash);
    if (parent === undefined) continue; // 由 ③ 报告
    linked += 1;
    if (parent.session_id !== event.session_id) {
      violations.push(`seq ${event.seq} 的前驱属于另一 session（${parent.session_id}）`);
      continue;
    }
    if (event.seq !== parent.seq + 1) {
      violations.push(
        `血统内 seq 不连续：${parent.seq} → ${event.seq}（应为 ${parent.seq + 1}，疑似丢事件或回退）`,
      );
    }
  }

  for (const event of events) {
    if (event.prev_event_hash === null && event.seq !== 1) {
      violations.push(`血统根事件 seq=${event.seq}，应为 1（${event.event_id}）`);
    }
  }

  // 读侧无法解析的整行 = 事件已经丢了，必须可见（残行的截断属正常崩溃恢复，不算违例）
  for (const note of notes) {
    if (note.kind === "unparsable_line") violations.push(note.detail);
  }

  return {
    name: "lineage_seq_contiguous",
    ok: violations.length === 0,
    detail:
      violations.length === 0
        ? `${events.length} 个事件、${linked} 条因果边，各血统内 seq 严格递增且无空洞`
        : `血统内 seq 校验失败：${summarize(violations)}`,
  };
}

function checkSessionIdentity(events: readonly EventEnvelope[], sessionId: string): Check {
  const foreign = events
    .filter((event) => event.session_id !== sessionId)
    .map((event) => `${event.event_id} 属于 ${event.session_id}`);
  return {
    name: "event_session_identity",
    ok: foreign.length === 0,
    detail:
      foreign.length === 0
        ? `全部 ${events.length} 个事件属于 session ${sessionId}`
        : `发现非当前 session 的事件：${summarize(foreign)}`,
  };
}

function checkProjection(
  events: readonly EventEnvelope[],
  stored: { ok: true; ledger: Ledger } | { ok: false; detail: string },
): Check {
  const replay = createReducer().reduce(events);
  if (!stored.ok) {
    return { name: "ledger_projection_matches", ok: false, detail: stored.detail };
  }
  const ledger = stored.ledger;
  const mismatches: string[] = [];
  if (ledger.reducer_version !== replay.reducer_version) {
    mismatches.push(
      `reducer_version: ledger=${ledger.reducer_version} 重放=${replay.reducer_version}`,
    );
  }
  if (ledger.input_hash !== replay.input_hash) {
    mismatches.push(`input_hash: ledger=${ledger.input_hash.slice(0, 12)} 重放=${replay.input_hash.slice(0, 12)}`);
  }
  if (ledger.output_hash !== replay.output_hash) {
    mismatches.push(
      `output_hash: ledger=${ledger.output_hash.slice(0, 12)} 重放=${replay.output_hash.slice(0, 12)}`,
    );
  }
  if (canonicalJson(ledger.entries) !== canonicalJson(replay.entries)) {
    mismatches.push("entries 内容不一致");
  }
  return {
    name: "ledger_projection_matches",
    ok: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `ledger.yaml 与事件流重放一致（input_hash ${replay.input_hash.slice(0, 12)}…）`
        : `投影漂移，可用 rebuildLedger 重建：${summarize(mismatches)}`,
  };
}

export async function runDoctor(session: SessionHandle): Promise<DoctorReport> {
  const events = await session.events.readAll();
  const diagnosable = session.events as Partial<EventStoreDiagnosticsReader>;
  const notes = typeof diagnosable.diagnostics === "function" ? diagnosable.diagnostics().notes : [];

  let stored: { ok: true; ledger: Ledger } | { ok: false; detail: string };
  try {
    stored = { ok: true, ledger: await session.readLedger() };
  } catch (error) {
    stored = {
      ok: false,
      detail: `ledger.yaml 不可读：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const checks: Check[] = [
    checkSessionIdentity(events, session.req_id),
    checkEventIdUnique(events),
    checkPrevChain(events),
    checkLineageSeq(events, notes),
    checkProjection(events, stored),
  ];

  return { ok: checks.every((check) => check.ok), checks };
}
