/**
 * 确定性原语：规范化 JSON、内容哈希、哈希链与因果序（ADR-0020 决策 3/4、注意点 3/4）。
 *
 * 本文件只放纯函数：同一输入必得同一输出，禁读时钟与随机数。
 * 读侧一律按逻辑时钟排序（ADR-0010 注意点 11：不依赖文件行序），
 * 因此 orderEvents 与哈希链一起放在这里，供 store / reducer / doctor 共用。
 */
import { createHash } from "node:crypto";
import type { EventEnvelope } from "./schema.js";

/** 输入哈希算法冻结进 schema_version（ADR-0020 注意点 4） */
export const HASH_ALGORITHM = "sha256";

const CHAIN_DOMAIN = "cord.event-chain.v1";
const CHAIN_GENESIS = `${CHAIN_DOMAIN}:genesis`;

export function sha256Hex(input: string): string {
  return createHash(HASH_ALGORITHM).update(input, "utf8").digest("hex");
}

/** 递归键排序；对象属性值为 undefined 时按「不存在」处理（与 JSON.stringify 一致） */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value instanceof Date) return value.toISOString();
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    target[key] = canonicalize(item);
  }
  return target;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value) ?? null);
}

/** 事件内容哈希：prev_event_hash 也在其中，故哈希本身构成因果链的一环 */
export function hashEvent(event: EventEnvelope): string {
  return sha256Hex(canonicalJson(event));
}

/** 事件流哈希链的终值 = reducer 的 input_hash（ADR-0020 决策 4） */
export function hashChain(events: readonly EventEnvelope[]): string {
  let accumulator = sha256Hex(CHAIN_GENESIS);
  for (const event of events) {
    accumulator = sha256Hex(`${CHAIN_DOMAIN}:${hashEvent(event)}:${accumulator}`);
  }
  return accumulator;
}

function compareEvents(a: EventEnvelope, b: EventEnvelope): number {
  const at = Date.parse(a.timestamp);
  const bt = Date.parse(b.timestamp);
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  return 0;
}

function insertSorted<T>(list: T[], item: T, compare: (a: T, b: T) => number): void {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const current = list[mid];
    if (current !== undefined && compare(current, item) < 0) low = mid + 1;
    else high = mid;
  }
  list.splice(low, 0, item);
}

/**
 * 因果链拓扑序为主、(timestamp, event_id) 兜底的全序（ADR-0020 决策 3）。
 * 允许多头（分支合并后的合法形态）；prev 指向不存在的事件时视为无前驱（doctor 负责报错）。
 */
export function orderEvents(events: readonly EventEnvelope[]): EventEnvelope[] {
  const total = events.length;
  const firstByHash = new Map<string, number>();
  for (let index = 0; index < total; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const hash = hashEvent(event);
    if (!firstByHash.has(hash)) firstByHash.set(hash, index);
  }

  const children: number[][] = Array.from({ length: total }, () => []);
  const indegree: number[] = new Array(total).fill(0);
  for (let index = 0; index < total; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.prev_event_hash === null) continue;
    const parent = firstByHash.get(event.prev_event_hash);
    if (parent === undefined || parent === index) continue;
    const bucket = children[parent];
    if (bucket !== undefined) bucket.push(index);
    indegree[index] = 1;
  }

  const ready: number[] = [];
  const ordered: EventEnvelope[] = [];
  for (let index = 0; index < total; index += 1) {
    if (indegree[index] === 0) {
      const event = events[index];
      if (event !== undefined) insertSorted(ready, index, (a, b) => compareEvents(events[a]!, events[b]!));
    }
  }

  const visited = new Set<number>();
  while (ready.length > 0) {
    const index = ready.shift();
    if (index === undefined) break;
    const event = events[index];
    if (event === undefined) continue;
    visited.add(index);
    ordered.push(event);
    for (const child of children[index] ?? []) {
      indegree[child] = (indegree[child] ?? 1) - 1;
      if (indegree[child] === 0) {
        insertSorted(ready, child, (a, b) => compareEvents(events[a]!, events[b]!));
      }
    }
  }

  // 理论不可达：仅当事件流被篡改出环时触发；兜底保证不丢事件且输出确定。
  if (ordered.length < total) {
    const leftovers: EventEnvelope[] = [];
    for (let index = 0; index < total; index += 1) {
      if (visited.has(index)) continue;
      const event = events[index];
      if (event !== undefined) leftovers.push(event);
    }
    leftovers.sort(compareEvents);
    ordered.push(...leftovers);
  }

  return ordered;
}
