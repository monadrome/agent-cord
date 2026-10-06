/**
 * 需求快照视图（ADR-0003：协调 agent 只持最新快照；ADR-0023 注意点 3：每节点执行前重建，
 * 长 run 中人在控制台改文档要能被下一个节点看到）。
 *
 * 快照 = 快照文档（截断）+ 账本条目摘要 + 工作流进度。历史细节留事件流，不进视图。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionHandle } from "../core/ports.js";
import { SNAPSHOT_DOC_FILES } from "../core/session.js";

export interface SnapshotDoc {
  /** 文件名（如 prd.md） */
  file: string;
  exists: boolean;
  /** 截断后的内容（上限 maxDocChars）；不存在或占位为空串 */
  content: string;
  /** 原始是否被截断（供 prompt 提示「还有全文可读」） */
  truncated: boolean;
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
}

export interface SnapshotOptions {
  /** 单文档纳入视图的上限（字符），默认 20000 */
  maxDocChars?: number;
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

  const docs: SnapshotDoc[] = [];
  for (const file of SNAPSHOT_DOC_FILES) {
    let content = "";
    let exists = false;
    let truncated = false;
    try {
      const raw = await readFile(join(session.dir, file), "utf8");
      exists = true;
      truncated = raw.length > maxDocChars;
      content = raw.slice(0, maxDocChars);
    } catch {
      // 文档缺失是合法状态（节点还没跑到）
    }
    docs.push({ file, exists, content, truncated });
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

  return {
    req_id: session.req_id,
    title: typeof titleValue === "string" ? titleValue : null,
    docs,
    ledger,
    workflow: { entered: [...entered], exited: [...exited] },
  };
}
