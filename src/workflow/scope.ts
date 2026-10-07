/** 执行版本的纯指纹与作用域匹配（ADR-0034）。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { WorkflowDef, WorkflowScope } from "../core/schema.js";

export function workflowRevision(def: WorkflowDef, binding?: { id: string; version: number }): string {
  return sha256Hex(canonicalJson({ domain: "cord.workflow-revision.v1", workflow: def, binding: binding ?? null }));
}

/** 无版本调用只匹配无版本事实，显式版本不回退历史事件。 */
export function matchesWorkflowScope(payload: unknown, scope: WorkflowScope): payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return value["workflow_id"] === scope.workflow_id && value["workflow_revision"] === scope.workflow_revision;
}
