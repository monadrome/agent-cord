/** ADR-0098：任务、验证与人审共用输入文件集合；协调保留全局观察。 */
import type { SessionHandle } from "../core/ports.js";
import type { WorkflowDef } from "../core/schema.js";
import { SNAPSHOT_DOC_FILES, isPlaceholderDoc } from "../core/session.js";
import { SessionFileError } from "../core/session-files.js";
import { readSnapshot, type RequirementSnapshot, type SnapshotOptions } from "./snapshot.js";

type Node = WorkflowDef["spec"]["nodes"][number];
export const NODE_INPUT_SCOPE_POLICY = "dependency-documents.v1";
const FILE_CHECKERS = new Set(["file-exists", "file-nonempty", "doc-has-section"]);

export function node_ancestors(def: WorkflowDef, node: Node): Set<string> {
  const by_id = new Map(def.spec.nodes.map(item => [item.id, item]));
  const visited = new Set<string>(); const visiting = new Set<string>([node.id]);
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new SessionFileError("输入依赖存在环，停止读取节点上下文");
    if (visited.has(id)) return;
    const upstream = by_id.get(id);
    if (upstream === undefined) throw new SessionFileError("输入依赖节点不存在，停止读取节点上下文");
    visiting.add(id);
    for (const dependency of upstream.depends_on) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const dependency of node.depends_on) visit(dependency);
  return visited;
}

/** null保留旧全快照语义，不等价于空集合。 */
export function node_input_files(def: WorkflowDef, node: Node): Set<string> | null {
  if (node.run?.input_scope === undefined) return null;
  if (node.run.input_scope.kind !== "dependencies") throw new SessionFileError("未知节点输入范围，停止派发");
  const ancestors = node_ancestors(def, node);
  const owners = new Set(def.spec.nodes.flatMap(item => item.artifact === undefined ? [] : [item.artifact]));
  const files = new Set<string>(["prd.md", ...SNAPSHOT_DOC_FILES.filter(file => !owners.has(file)), ...node.run.input_scope.documents]);
  for (const item of [...def.spec.nodes, node]) if ((item.id === node.id || ancestors.has(item.id)) && item.artifact !== undefined) files.add(item.artifact);
  for (const gate of node.gates) for (const check of gate.checks) {
    const path = check.with?.["path"];
    if (FILE_CHECKERS.has(check.ref) && typeof path === "string") files.add(path);
  }
  return files;
}

export async function readNodeSnapshot(def: WorkflowDef, node: Node, session: SessionHandle, options: Omit<SnapshotOptions, "files" | "include_default_documents"> = {}): Promise<RequirementSnapshot> {
  const files = node_input_files(def, node);
  const snapshot = await readSnapshot(session, { ...options,
    files: files === null ? [...def.spec.nodes, node].flatMap(item => item.artifact === undefined ? [] : [item.artifact]) : [...files].sort(),
    ...(files === null ? {} : { include_default_documents: false }),
  });
  for (const file of node.run?.input_scope?.documents ?? []) {
    const document = snapshot.docs.find(item => item.file === file);
    if (document === undefined || !document.exists || document.content_length === 0 || isPlaceholderDoc(document.content + (document.tail_content ?? ""))) {
      throw new SessionFileError("声明的额外输入文档缺失或仍为占位，停止派发");
    }
  }
  return snapshot;
}
