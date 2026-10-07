/**
 * 需求快照视图（ADR-0003：协调 agent 只持最新快照；ADR-0023 注意点 3：每节点执行前重建，
 * 长 run 中人在控制台改文档要能被下一个节点看到）。
 *
 * 快照 = 快照文档（截断）+ 账本条目摘要 + 工作流进度。历史细节留事件流，不进视图。
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionHandle } from "../core/ports.js";
import { SNAPSHOT_DOC_FILES } from "../core/session.js";
import { canonicalJson, hashChain, sha256Hex } from "../core/hash.js";

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
}

export interface WorkflowProgress {
  entered: string[];
  exited: string[];
}

export interface RequirementSnapshot {
  req_id: string;
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
}

/** 解析 session 内相对文件；越界、绝对路径和空路径均返回 null。 */
export function resolveSessionFile(sessionDir: string, file: string): string | null {
  if (file.trim().length === 0 || isAbsolute(file)) return null;
  const root = resolve(sessionDir);
  const candidate = resolve(root, file);
  const relativePath = relative(root, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return candidate;
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
  const maxDocChars = options.maxDocChars ?? 20_000;

  const files = [...new Set([...SNAPSHOT_DOC_FILES, ...(options.files ?? [])])];
  const docs: SnapshotDoc[] = [];
  for (const file of files) {
    let content = "";
    let exists = false;
    let truncated = false;
    let contentHash: string | null = null;
    let contentLength = 0;
    const filePath = resolveSessionFile(session.dir, file);
    try {
      if (filePath === null) throw new Error("invalid session-relative path");
      const raw = await readFile(filePath, "utf8");
      exists = true;
      truncated = raw.length > maxDocChars;
      content = raw.slice(0, maxDocChars);
      contentHash = sha256Hex(raw);
      contentLength = raw.length;
    } catch {
      // 文档缺失是合法状态（节点还没跑到）
    }
    docs.push({ file, exists, content, truncated, content_hash: contentHash, content_length: contentLength });
  }

  let ledger: SnapshotLedgerEntry[] = [];
  try {
    const projection = await session.readLedger();
    ledger = projection.entries.map((entry) => ({
      entry_id: entry.entry_id,
      title: entry.title,
      status: entry.status,
    }));
  } catch {
    // 账本读不到不阻断快照（gate 侧自会 fail-closed）
  }

  const events = await session.events.readOrdered();
  const created = events.find((event) => event.type === "session.created");
  const titleValue = asRecord(created?.payload)?.["title"];
  const entered = new Set<string>();
  const exited = new Set<string>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const nodeId = payload?.["node_id"];
    if (typeof nodeId !== "string") continue;
    if (event.type === "workflow.node.entered") entered.add(nodeId);
    else if (event.type === "workflow.node.exited") exited.add(nodeId);
  }

  const eventSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  const eventChainHash = hashChain(events);
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
    workflow: { entered: [...entered], exited: [...exited] },
    event_seq: eventSeq,
    event_chain_hash: eventChainHash,
  };

  return {
    req_id: session.req_id,
    title: typeof titleValue === "string" ? titleValue : null,
    docs,
    ledger,
    workflow: { entered: [...entered], exited: [...exited] },
    snapshot_id: sha256Hex(canonicalJson(fingerprint)),
    event_seq: eventSeq,
    event_chain_hash: eventChainHash,
  };
}
