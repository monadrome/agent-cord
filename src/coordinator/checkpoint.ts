/** 稳定语义输入指纹与审批上下文；控制事件的推进不使指纹自行变化（ADR-0030）。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { SessionHandle } from "../core/ports.js";
import type { WorkflowDef } from "../core/schema.js";
import { readSnapshot, type RequirementSnapshot } from "./snapshot.js";

type Node = WorkflowDef["spec"]["nodes"][number];

export function executionInputHash(
  def: WorkflowDef,
  node: Node,
  snapshot: RequirementSnapshot,
  max_pack_chars = 60_000,
): string {
  return sha256Hex(canonicalJson({
    domain: "cord.execution-input.v1",
    workflow: def,
    node,
    req_id: snapshot.req_id,
    title: snapshot.title,
    max_pack_chars,
    docs: snapshot.docs.filter((doc) => node.run?.readonly === true || doc.file !== node.artifact)
      .map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
    exited: snapshot.workflow.exited.filter((id) => id !== node.id),
  }));
}

export async function readApprovalContextHash(def: WorkflowDef, node: Node, session: SessionHandle): Promise<string> {
  const snapshot = await readSnapshot(session, {
    workflow_id: def.metadata.id,
    files: [...def.spec.nodes, node].flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
  });
  return sha256Hex(canonicalJson({
    domain: "cord.approval-context.v1", workflow: def, node,
    req_id: snapshot.req_id, title: snapshot.title,
    docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
  }));
}
