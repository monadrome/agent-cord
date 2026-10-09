/** 稳定语义输入指纹与审批上下文；控制事件的推进不使指纹自行变化（ADR-0030）。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { SessionHandle } from "../core/ports.js";
import type { WorkflowDef } from "../core/schema.js";
import { readSnapshot, type RequirementSnapshot } from "./snapshot.js";
import { nodeProducesArtifact } from "./artifact-policy.js";
import { WORKER_CONTEXT_POLICY } from "./context-pack.js";

type Node = WorkflowDef["spec"]["nodes"][number];

export function executionInputHash(
  def: WorkflowDef,
  node: Node,
  snapshot: RequirementSnapshot,
  max_pack_chars = 60_000,
  agent_configuration_hash: string | null = null,
  source_hash: string | null = null,
): string {
  const clarifications = snapshot.clarifications ?? [];
  return sha256Hex(canonicalJson({
    domain: clarifications.length === 0 ? "cord.execution-input.v4" : "cord.execution-input.v5", context_policy: WORKER_CONTEXT_POLICY,
    ...(clarifications.length === 0 ? {} : { clarifications }),
    ...(source_hash === null ? {} : { source_hash }),
    agent_configuration_hash,
    workflow: def,
    ...(snapshot.workflow_revision !== undefined ? { workflow_revision: snapshot.workflow_revision } : {}),
    node,
    req_id: snapshot.req_id,
    title: snapshot.title,
    max_pack_chars,
    docs: snapshot.docs.filter((doc) => !nodeProducesArtifact(node) || doc.file !== node.artifact)
      .map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
    exited: snapshot.workflow.exited.filter((id) => id !== node.id),
  }));
}

export async function readApprovalContextHash(def: WorkflowDef, node: Node, session: SessionHandle, agent_configuration_hash: string | null = null, workflow_revision?: string): Promise<string> {
  const snapshot = await readSnapshot(session, {
    workflow_id: def.metadata.id,
    workflow_revision,
    files: [...def.spec.nodes, node].flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
  });
  return sha256Hex(canonicalJson({
    domain: (snapshot.clarifications?.length ?? 0) === 0 ? "cord.approval-context.v1" : "cord.approval-context.v2", workflow: def, node,
    ...((snapshot.clarifications?.length ?? 0) === 0 ? {} : { clarifications: snapshot.clarifications }),
    ...(workflow_revision !== undefined ? { workflow_revision } : {}),
    agent_configuration_hash,
    req_id: snapshot.req_id, title: snapshot.title,
    docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
  }));
}
