/** worker 权限与宿主产物通道是不同维度（ADR-0038）。 */
import type { WorkflowDef } from "../core/schema.js";

export function nodeProducesArtifact(node: WorkflowDef["spec"]["nodes"][number]): boolean {
  return node.artifact !== undefined && (node.run?.readonly !== true || node.run.output === "text");
}
