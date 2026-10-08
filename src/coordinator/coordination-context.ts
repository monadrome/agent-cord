/** ADR-0046：独立协调的首尾采集与确定性文档预算。 */
import type { SessionHandle } from "../core/ports.js";
import type { WorkflowDef } from "../core/schema.js";
import { readSnapshot, sliceDocumentExcerpt, type SnapshotDoc } from "./snapshot.js";

export const COORDINATION_CONTEXT_POLICY = "balanced-head-tail.v1";

export function readCoordinationSnapshot(def: WorkflowDef, session: SessionHandle, workflow_revision?: string) {
  return readSnapshot(session, { workflow_id: def.metadata.id, workflow_revision, excerpt_mode: "head_tail",
    files: def.spec.nodes.flatMap((node) => node.artifact === undefined ? [] : [node.artifact]) });
}

interface DocumentSelection {
  file: string;
  included_chars: number;
  omitted_chars: number;
  ranges: Array<[number, number]>;
  texts: string[];
}

function selectDocument(doc: SnapshotDoc, limit: number): DocumentSelection {
  const selection: DocumentSelection = { file: doc.file, included_chars: 0, omitted_chars: doc.content_length, ranges: [], texts: [] };
  const add = (content: string, start: number, end: number, offset = 0) => {
    const excerpt = sliceDocumentExcerpt(content, start, end);
    if (excerpt.text.length === 0) return;
    selection.ranges.push([offset + excerpt.start, offset + excerpt.end]);
    selection.texts.push(excerpt.text);
    selection.included_chars += excerpt.text.length;
    selection.omitted_chars -= excerpt.text.length;
  };
  const available = doc.content.length + (doc.tail_content?.length ?? 0);
  if (limit >= available || (doc.tail_content === undefined && doc.truncated)) {
    add(doc.content, 0, Math.min(limit, doc.content.length));
    if (doc.tail_content !== undefined) add(doc.tail_content, 0, doc.tail_content.length, doc.content_length - doc.tail_content.length);
  } else {
    const tail = doc.tail_content ?? doc.content;
    let head_chars = Math.min(doc.content.length, Math.floor(limit / 2));
    const tail_chars = Math.min(tail.length, limit - head_chars);
    head_chars = Math.min(doc.content.length, limit - tail_chars);
    add(doc.content, 0, head_chars);
    add(tail, tail.length - tail_chars, tail.length, doc.content_length - tail.length);
  }
  return selection;
}

function renderDocuments(selections: DocumentSelection[]): string {
  const index = selections.map(({ texts: _texts, ...entry }) => entry);
  return `\n\ndocument_excerpts: ${JSON.stringify(index)}` + selections.map((selection) =>
    selection.texts.length === 0 ? "" : `\n\n## 文档 ${selection.file}\n` + selection.texts.map((text, index) =>
      `### 字符 ${selection.ranges[index]![0]}:${selection.ranges[index]![1]}\n${text}\n`).join("\n"),
  ).join("");
}

export function buildCoordinationDocuments(docs: readonly SnapshotDoc[], max_chars: number): string {
  const candidates = docs.filter((doc) => doc.exists && doc.content.length + (doc.tail_content?.length ?? 0) > 0);
  // 两个最大偏移的空片段为索引/标题预留上界，正文字符可以按线性预算分配。
  const reserved = renderDocuments(candidates.map((doc) => ({ file: doc.file, included_chars: doc.content_length, omitted_chars: doc.content_length,
    ranges: [[doc.content_length, doc.content_length], [doc.content_length, doc.content_length]], texts: ["", ""] }))).length;
  if (reserved > max_chars) throw new Error("协调文档片段元信息超过上下文预算");
  let remaining = max_chars - reserved;
  const limits = new Map<string, number>();
  const by_size = [...candidates].sort((a, b) =>
    a.content.length + (a.tail_content?.length ?? 0) - b.content.length - (b.tail_content?.length ?? 0));
  for (const [index, doc] of by_size.entries()) {
    const limit = Math.min(doc.content.length + (doc.tail_content?.length ?? 0), Math.floor(remaining / (by_size.length - index)));
    limits.set(doc.file, limit);
    remaining -= limit;
  }
  const text = renderDocuments(candidates.map((doc) => selectDocument(doc, limits.get(doc.file)!)));
  if (text.length > max_chars) throw new Error("协调文档片段超过上下文预算");
  return text;
}
