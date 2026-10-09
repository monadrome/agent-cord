/** ADR-0064：从发布映射生成宿主覆盖身份，不解析 worker 的通过声明。 */
import { canonicalJson } from "../core/hash.js";
import type { GoalConfig, GoalAcceptanceEvidence } from "../core/schema.js";

export function goalAcceptanceEvidence(goal: GoalConfig, verification_event_ids: readonly string[]): GoalAcceptanceEvidence | undefined {
  if (goal.acceptance === undefined) return undefined;
  if (verification_event_ids.length !== goal.checks.length || new Set(verification_event_ids).size !== verification_event_ids.length) throw new Error("验收覆盖必须绑定全部唯一宿主检查事件");
  return goal.acceptance.map(condition => ({ acceptance_id: condition.id,
    verification_event_ids: condition.checks.map(id => {
      const index = goal.checks.findIndex(check => check.id === id);
      if (index < 0 || verification_event_ids[index] === undefined) throw new Error("验收条件缺少声明的宿主检查");
      return verification_event_ids[index]!;
    }),
  }));
}

export function goalAcceptanceIsComplete(goal: GoalConfig, evidence: GoalAcceptanceEvidence | undefined, verification_event_ids: readonly string[]): boolean {
  if (goal.acceptance === undefined) return evidence === undefined;
  if (evidence === undefined) return false;
  try { return canonicalJson(evidence) === canonicalJson(goalAcceptanceEvidence(goal, verification_event_ids)); }
  catch { return false; }
}

function tableText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "\\|").replaceAll("`", "&#96;").replace(/[\r\n]+/g, " ");
}

export function renderGoalAcceptance(goal: GoalConfig, evidence: GoalAcceptanceEvidence | undefined): string {
  if (goal.acceptance === undefined || evidence === undefined) return "";
  return `\n\n## 宿主验收覆盖\n\n| 条件 | 验收要求 | 实际检查 | 通过事件 |\n|---|---|---|---|\n${goal.acceptance.map((condition, index) =>
    `| ${condition.id} | ${tableText(condition.criterion)} | ${condition.checks.map(tableText).join(", ")} | ${evidence[index]!.verification_event_ids.join(", ")} |`).join("\n")}\n\n宿主实际执行关联检查并通过；条件与测试的业务充分性仍需最终人工 review。\n`;
}
