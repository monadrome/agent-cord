/**
 * 需求快照视图（ADR-0003：协调 agent 只持最新快照；ADR-0023 注意点 3：每节点执行前重建，
 * 长 run 中人在控制台改文档要能被下一个节点看到）。
 *
 * 快照 = 快照文档（截断）+ 账本条目摘要 + 工作流进度。历史细节留事件流，不进视图。
 */
import type { SessionHandle } from "../core/ports.js";
import { SNAPSHOT_DOC_FILES } from "../core/session.js";
import { canonicalJson, hashChain, sha256Hex } from "../core/hash.js";
import { createReducer } from "../core/reducer.js";
import { readSessionDocument } from "./session-files.js";
import { matchesWorkflowScope } from "../workflow/scope.js";

export { resolveSessionFile } from "./session-files.js";

export interface SnapshotDoc {
  /** 文件名（如 prd.md） */
  file: string;
  exists: boolean;
  /** 截断后的内容（上限 maxDocChars）；不存在或占位为空串 */
  content: string;
  /** 原始是否被截断（供 prompt 提示「还有全文可读」） */
  truncated: boolean;
  /** 完整文件内容 hash；prompt 只携带 content 的截断部分 */
  content_hash: string | null;
  /** 完整文件字符数 */
  content_length: number;
}

export interface SnapshotLedgerEntry {
  entry_id: string;
  title: string;
  status: string;
  conflict: boolean;
}

export interface WorkflowProgress {
  entered: string[];
  exited: string[];
  /** ADR-0032：同批事件中的待人工门禁，协调提议不能越过。 */
  waiting?: Array<{ node_id: string; gate_id: string; waiting_event_id: string }>;
}

export interface RequirementSnapshot {
  req_id: string;
  workflow_revision?: string;
  title: string | null;
  docs: SnapshotDoc[];
  ledger: SnapshotLedgerEntry[];
  workflow: WorkflowProgress;
  /** 由快照输入和事件流 provenance 派生的稳定指纹 */
  snapshot_id: string;
  /** 采集时事件流的最大 seq 与 chain hash */
  event_seq: number;
  event_chain_hash: string;
}

export interface SnapshotOptions {
  /** 单文档纳入视图的上限（字符），默认 20000 */
  maxDocChars?: number;
  /** workflow 声明的自定义 artifact；会与固定四个快照文档合并去重 */
  files?: readonly string[];
  /** 仅投影该 workflow 的节点进度；省略时保留 session 全部进度 */
  workflow_id?: string;
  workflow_revision?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readSnapshot(
  session: SessionHandle,
  options: SnapshotOptions = {},
): Promise<RequirementSnapshot> {
  if (options.workflow_revision !== undefined && options.workflow_id === undefined) throw new Error("执行版本必须同时指定 workflow_id");
  const maxDocChars = options.maxDocChars ?? 20_000;

  const files = [...new Set([...SNAPSHOT_DOC_FILES, ...(options.files ?? [])])];
  const docs: SnapshotDoc[] = [];
  for (const file of files) {
    let content = "";
    let exists = false;
    let truncated = false;
    let contentHash: string | null = null;
    let contentLength = 0;
    const raw = await readSessionDocument(session.dir, file);
    if (raw !== null) {
      exists = true;
      truncated = raw.length > maxDocChars;
      content = raw.slice(0, maxDocChars);
      contentHash = sha256Hex(raw);
      contentLength = raw.length;
    }
    docs.push({ file, exists, content, truncated, content_hash: contentHash, content_length: contentLength });
  }

  // 账本、进度与 provenance 必须来自同次事件读取，磁盘投影可滞后或缺失。
  const events = await session.events.readOrdered();
  const ledger: SnapshotLedgerEntry[] = createReducer().reduce(events).entries.map((entry) => ({
    entry_id: entry.entry_id,
    title: entry.title,
    status: entry.status,
    conflict: entry.conflict,
  }));
  const created = events.find((event) => event.type === "session.created");
  const titleValue = asRecord(created?.payload)?.["title"];
  const entered = new Set<string>();
  const exited = new Set<string>();
  const waiting = new Map<string, { workflow_id: unknown; workflow_revision: unknown; node_id: string; gate_id: string; waiting_event_id: string }>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (options.workflow_id !== undefined && !matchesWorkflowScope(payload, { workflow_id: options.workflow_id, workflow_revision: options.workflow_revision })) continue;
    const nodeId = payload?.["node_id"];
    if (event.type === "workflow.run.cancelled") {
      for (const [key, gate] of waiting) if (gate.workflow_id === payload?.["workflow_id"] && gate.workflow_revision === payload?.["workflow_revision"]) waiting.delete(key);
    }
    if (typeof nodeId !== "string") continue;
    if (event.type === "workflow.node.entered") entered.add(nodeId);
    else if (event.type === "workflow.node.exited") exited.add(nodeId);
    const gate_id = payload?.["gate_id"];
    if (typeof gate_id !== "string") continue;
    const key = JSON.stringify([payload?.["workflow_id"], payload?.["workflow_revision"], nodeId, gate_id]);
    if (event.type === "gate.waiting") waiting.set(key, { workflow_id: payload?.["workflow_id"], workflow_revision: payload?.["workflow_revision"], node_id: nodeId, gate_id, waiting_event_id: event.event_id });
    else if (event.type === "gate.resolved") waiting.delete(key);
    else if (event.type === "gate.invalidated" && waiting.get(key)?.waiting_event_id === payload?.["waiting_event_id"]) waiting.delete(key);
  }

  const eventSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  const eventChainHash = hashChain(events);
  const workflow = { entered: [...entered], exited: [...exited], waiting: [...waiting.values()].map(({ workflow_id: _workflow_id, workflow_revision: _workflow_revision, ...gate }) => gate) };
  const fingerprint = {
    req_id: session.req_id,
    title: typeof titleValue === "string" ? titleValue : null,
    docs: docs.map(({ file, exists: docExists, content_hash, content_length }) => ({
      file,
      exists: docExists,
      content_hash,
      content_length,
    })),
    ledger,
    workflow,
    workflow_id: options.workflow_id ?? null,
    ...(options.workflow_revision !== undefined ? { workflow_revision: options.workflow_revision } : {}),
    event_seq: eventSeq,
    event_chain_hash: eventChainHash,
  };

  return {
    req_id: session.req_id,
    ...(options.workflow_revision !== undefined ? { workflow_revision: options.workflow_revision } : {}),
    title: typeof titleValue === "string" ? titleValue : null,
    docs,
    ledger,
    workflow,
    snapshot_id: sha256Hex(canonicalJson(fingerprint)),
    event_seq: eventSeq,
    event_chain_hash: eventChainHash,
  };
}
