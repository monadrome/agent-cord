/** ADR-0041/0103：节点范围取并集，扫描与冻结使用内核同一实现。 */
import { VerificationInputError, type WorkflowDef } from "agent-cord";
import { z } from "zod";
export { readVerificationSource, VerificationInputError, type VerificationSource } from "agent-cord";

const InputPathsSchema = z.array(z.string().min(1).max(500)).min(1).max(64);
export function verificationSourceInputs(node: WorkflowDef["spec"]["nodes"][number]): string[] {
  const paths: string[] = [...(node.run?.goal?.inputs ?? [])];
  for (const gate of node.gates) for (const check of gate.checks) {
    if (check.ref !== "verification-passed" || check.with?.["inputs"] === undefined) continue;
    const parsed = InputPathsSchema.safeParse(check.with["inputs"]);
    if (!parsed.success) throw new VerificationInputError("verification-passed.inputs 必须声明 1-64 个文件或目录路径");
    paths.push(...parsed.data);
  }
  return [...new Set(paths)].sort();
}
