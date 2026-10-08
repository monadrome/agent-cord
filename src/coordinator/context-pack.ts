/**
 * 上下文包构建（W1.6 两层剪裁，ADR-0023 决策 2）：
 * - 高信号层：PRD 全文（截断上限内）+ 上游已完成节点的 artifact 内容 + 账本条目摘要；
 * - 定位符层：快照文件路径清单，worker agent 按需自取全文（事件流永不进 LLM 上下文）。
 */
import type { WorkflowDef } from "../core/schema.js";
import type { WorkflowNode } from "../workflow/executor.js";
import { isPlaceholderDoc } from "../core/session.js";
import type { RequirementSnapshot } from "./snapshot.js";

export interface ContextPackOptions {
  /** 上下文包总字符上限（超出砍上游产物，PRD 与任务说明永远保留），默认 60000 */
  maxPackChars?: number;
}

/** 按产物类型的缺省任务模板（node.run.prompt 未提供时使用） */
const ARTIFACT_TASKS: Record<string, string> = {
  "prd.md": "撰写或完善本需求的 PRD：背景与问题、目标、用户故事、验收标准、明确不做什么。",
  "plan.md": "基于 PRD 与已有决策产出实施计划：任务分解（可勾选清单）、里程碑、风险与依赖。",
  "adr.md": "记录本需求的关键技术决策：背景、备选方案（至少两个）、决策与理由、影响面。",
  "findings.md": "产出验证报告：验证项逐条列出、证据（命令/输出摘要/文件锚点）、结论（通过 / 不通过 / 待人工）。",
};

const GENERIC_TASK = "完成本节点的任务并产出要求的文档；不确定处显式标注「待人工确认」，不要编造。";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (matched, key: string) => vars[key] ?? matched);
}

/** 节点的任务说明：run.prompt 模板渲染，缺省按 artifact 分档 */
export function taskInstructions(node: WorkflowNode, reqId: string): string {
  const vars = {
    req_id: reqId,
    node_id: node.id,
    artifact: node.artifact ?? "",
  };
  if (node.run?.prompt !== undefined && node.run.prompt.trim().length > 0) {
    return renderTemplate(node.run.prompt, vars).trim();
  }
  const base = (node.artifact !== undefined && ARTIFACT_TASKS[node.artifact]) || GENERIC_TASK;
  return renderTemplate(base, vars);
}

/** 上游产物：依赖闭包中已完成节点的 artifact 文件（去重、保序） */
export function upstreamArtifacts(def: WorkflowDef, node: WorkflowNode, exited: ReadonlySet<string>): string[] {
  const byId = new Map(def.spec.nodes.map((item) => [item.id, item]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const item = byId.get(id);
    if (item === undefined) return;
    if (exited.has(id) && item.artifact !== undefined) out.push(item.artifact);
    for (const dep of item.depends_on) visit(dep);
  };
  for (const dep of node.depends_on) visit(dep);
  return out;
}

export function buildContextPack(
  def: WorkflowDef,
  node: WorkflowNode,
  snapshot: RequirementSnapshot,
  options: ContextPackOptions = {},
): string {
  const maxPackChars = options.maxPackChars ?? 60_000;
  const exited = new Set(snapshot.workflow.exited);
  const upstream = upstreamArtifacts(def, node, exited);
  const docByFile = new Map(snapshot.docs.map((doc) => [doc.file, doc]));
  const instructions = taskInstructions(node, snapshot.req_id);

  const sections: string[] = [
    `# 任务上下文包（协调 agent 生成）`,
    ``,
    `## 需求`,
    `- req_id: ${snapshot.req_id}`,
    `- 标题: ${snapshot.title ?? "（未命名）"}`,
    `- 当前节点: ${node.id}${node.artifact !== undefined ? `（产物: ${node.artifact}）` : ""}`,
    `- 已完成节点: ${snapshot.workflow.exited.join(" → ") || "（无）"}`,
    `- 快照指纹: ${snapshot.snapshot_id}（事件 seq ≤ ${snapshot.event_seq}）`,
    ...(snapshot.workflow_revision !== undefined ? [`- 执行版本: ${snapshot.workflow_revision}`] : []),
    ``,
    `## 任务`,
    instructions,
  ];

  const prd = docByFile.get("prd.md");
  if (prd !== undefined && prd.exists && !isPlaceholderDoc(prd.content)) {
    sections.push(``, `## PRD（全文${prd.truncated ? "·已截断" : ""}）`, prd.content.trim());
  }

  // 高信号层：上游产物内容（预算内逐个纳入，超预算降级为只给定位符）
  const upstreamBlocks: string[] = [];
  let budget = maxPackChars - sections.join("\n").length - 4_000; // 给账本/定位符/输出要求留余量
  for (const file of upstream) {
    const doc = docByFile.get(file);
    if (doc === undefined || !doc.exists || isPlaceholderDoc(doc.content)) continue;
    const block = `### ${file}${doc.truncated ? "（截断）" : ""}\n${doc.content.trim()}`;
    if (budget - block.length < 0) break;
    upstreamBlocks.push(block);
    budget -= block.length;
  }
  if (upstreamBlocks.length > 0) {
    sections.push(``, `## 上游产物（已完成节点）`, upstreamBlocks.join("\n\n"));
  }

  if (snapshot.ledger.length > 0) {
    const lines = snapshot.ledger.map((entry) =>
      `- [${entry.status}${entry.conflict ? " · 冲突，待人工处理" : ""}] ${entry.entry_id} ${entry.title}`,
    );
    sections.push(``, `## 共识账本（已入账条目）`, lines.join("\n"));
  }

  const locators = snapshot.docs
    .filter((doc) => doc.exists)
    .map((doc) => `- cord/${snapshot.req_id}/${doc.file}`);
  sections.push(
    ``,
    `## 定位符层（按需自取全文）`,
    ...locators,
    ``,
    `## 纪律`,
    `- 结论必须可指认证据（文件锚点 / 命令输出）；无证据的推断显式标注为假设。`,
    `- 不要修改与本节点无关的快照文档。`,
  );

  if (node.artifact !== undefined && node.run?.output === "text") {
    sections.push(
      ``, `## 输出要求`,
      `- 在最终回复中给出完整 UTF-8 Markdown 产物，协调层将代写为 cord/${snapshot.req_id}/${node.artifact} 的 draft。`,
      `- 不要自行写入声明产物；以最终文本作为本次报告的唯一内容。`,
      ...(node.run.readonly === true ? [`- 本任务保持只读，不修改任何文件。`] : []),
    );
  } else if (node.artifact !== undefined && node.run?.readonly !== true) {
    sections.push(
      ``,
      `## 输出要求`,
      `- 把最终产物写入文件 \`cord/${snapshot.req_id}/${node.artifact}\`（UTF-8 Markdown，完整覆盖写）。`,
      `- 若无法写文件，则在最终回复中直接给出完整 Markdown 内容（协调层会代写为 draft）。`,
    );
  }

  return sections.join("\n");
}
