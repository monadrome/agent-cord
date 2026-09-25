/**
 * Workflow YAML 加载器（ADR-0014：apiVersion 化定义 + 三级校验器的加载期校验）。
 *
 * 校验分两层：
 * 1. schema 层：`WorkflowDefSchema`（zod），错误信息带字段路径；
 * 2. 引用层：节点/gate 的引用完整性（depends_on 目标存在、gate.attach.node 与所属节点一致、
 *    gate.id 全局唯一、gate.checks 非空）——schema 表达不了，但配错会静默改变流程拓扑。
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { WorkflowDefSchema, type WorkflowDef } from "../core/schema.js";

export class WorkflowLoadError extends Error {
  readonly source: string;
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(`workflow 定义加载失败（${source}）：\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "WorkflowLoadError";
    this.source = source;
    this.issues = issues;
  }
}

export async function loadWorkflowFile(path: string): Promise<WorkflowDef> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new WorkflowLoadError(path, [`无法读取文件：${message(err)}`]);
  }
  return parseWorkflow(text, { source: path });
}

export interface ParseWorkflowOptions {
  /** 错误信息里显示的来源名（文件路径 / 测试名） */
  source?: string;
}

export function parseWorkflow(text: string, options: ParseWorkflowOptions = {}): WorkflowDef {
  const source = options.source ?? "<inline>";
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new WorkflowLoadError(source, [`YAML 解析失败：${message(err)}`]);
  }
  const parsed = WorkflowDefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowLoadError(
      source,
      parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
    );
  }
  const issues = validateReferences(parsed.data);
  if (issues.length > 0) throw new WorkflowLoadError(source, issues);
  return parsed.data;
}

/** 引用完整性校验；返回带路径的错误信息（空数组 = 通过）。 */
export function validateReferences(def: WorkflowDef): string[] {
  const issues: string[] = [];
  const nodeIds = new Set<string>();
  const duplicated = new Set<string>();
  for (const node of def.spec.nodes) {
    if (nodeIds.has(node.id)) duplicated.add(node.id);
    nodeIds.add(node.id);
  }
  for (const id of duplicated) issues.push(`spec.nodes: 节点 id 重复：${id}`);

  const gateIds = new Set<string>();
  for (const [nodeIndex, node] of def.spec.nodes.entries()) {
    const at = `spec.nodes.${nodeIndex}`;
    for (const [depIndex, dep] of node.depends_on.entries()) {
      if (dep === node.id) issues.push(`${at}.depends_on.${depIndex}: 节点不能依赖自身（${dep}）`);
      else if (!nodeIds.has(dep)) issues.push(`${at}.depends_on.${depIndex}: 依赖的节点不存在：${dep}`);
    }
    for (const [gateIndex, gate] of node.gates.entries()) {
      const gateAt = `${at}.gates.${gateIndex}`;
      if (gateIds.has(gate.id)) issues.push(`${gateAt}.id: gate id 重复：${gate.id}`);
      gateIds.add(gate.id);
      if (gate.attach.node !== node.id) {
        issues.push(`${gateAt}.attach.node: 应等于所属节点 id "${node.id}"，实际为 "${gate.attach.node}"`);
      }
      if (gate.checks.length === 0) {
        issues.push(`${gateAt}.checks: gate 未声明任何 checker（空 checks 不放行，fail-closed）`);
      }
    }
  }
  return issues;
}

function formatPath(path: readonly unknown[]): string {
  return path.length === 0 ? "<root>" : path.map((segment) => String(segment)).join(".");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
