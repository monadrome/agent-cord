/**
 * 工作区级自定义 agent 注册（ADR-0023 决策 6）：`cord/agents.yaml`。
 *
 * 三种形态：
 * 1. ACP agent：{ kind: acp, bin, args? } —— 子命令缺省 ["acp"]；
 * 2. 基于内置 headless 模板定制：{ kind: headless, template: claude|codex|kimi, bin?, env? }；
 * 3. 自定义 headless CLI：{ kind: headless, bin, args: ["run", "{{prompt}}", ...] }
 *    —— args 里 `{{prompt}}` 占位替换为完整 prompt；该形态不支持 resume 与只读工具收敛
 *    （readonly 任务不会追加任何限制参数），需要这些能力请用形态 2。
 *
 * 纪律：逐条降级——单条配置非法记 warning 跳过，不阻断其他注册；文件整体不可解析才抛错。
 * BYO 凭证：env 只透传，daemon 不代管厂商凭据。
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentDriver } from "../core/ports.js";
import { AcpDriver } from "./acp.js";
import {
  HeadlessDriver,
  getHeadlessCliTemplate,
  registerHeadlessCliTemplate,
} from "./headless.js";
import { resolveDriver } from "./registry.js";

const AgentsYamlSchema = z.object({
  agents: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("acp"),
        bin: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      z.object({
        kind: z.literal("headless"),
        /** 复用内置模板的参数形态（claude/codex/kimi 或已注册模板） */
        template: z.string().min(1).optional(),
        bin: z.string().min(1),
        /** 自定义参数模板（{{prompt}} 占位）；与 template 二选一 */
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    ]),
  ),
});

export type AgentsYaml = z.infer<typeof AgentsYamlSchema>;

export interface AgentsLoadResult {
  /** 成功注册的 agent 名 */
  registered: string[];
  /** 逐条降级：非法条目的原因（不阻断其他注册） */
  warnings: string[];
}

/** 解析 agents.yaml 文本（纯函数，无 IO 之外的副作用）；语法整体非法 → 抛错带字段路径 */
export function parseAgentsYaml(text: string): AgentsLoadResult & { yaml: AgentsYaml | null } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`agents.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = AgentsYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `agents.${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("；");
    throw new Error(`agents.yaml 不符合 schema：${detail}`);
  }
  return { yaml: parsed.data, registered: [], warnings: [] };
}

/**
 * 把 agents.yaml 的定义注册进驱动体系（headless args 模板注册进模板表）；
 * 返回每条目的注册结果。ACP 条目无需预注册（解析时按名构造），但这里统一校验可见性。
 */
export function registerAgentsYaml(yaml: AgentsYaml): AgentsLoadResult {
  const registered: string[] = [];
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(yaml.agents)) {
    if (entry.kind === "acp") {
      registered.push(name);
      continue;
    }
    // headless：template 形态要求模板存在；args 形态注册为独立模板
    if (entry.template !== undefined) {
      if (getHeadlessCliTemplate(entry.template) === undefined) {
        warnings.push(`agents.${name}: 未知 headless 模板 "${entry.template}"，跳过注册`);
        continue;
      }
    } else if (entry.args !== undefined) {
      const argsTemplate = entry.args;
      registerHeadlessCliTemplate({
        name,
        bin: entry.bin,
        args: ({ prompt }) => argsTemplate.map((arg) => arg.replaceAll("{{prompt}}", prompt)),
      });
    } else {
      warnings.push(`agents.${name}: headless 需要 template 或 args 之一，跳过注册`);
      continue;
    }
    registered.push(name);
  }
  return { registered, warnings };
}

/** 从文件加载并注册；文件不存在 → 空结果（agents.yaml 是可选的） */
export async function loadAgentsFile(
  path: string,
): Promise<AgentsLoadResult & { yaml: AgentsYaml | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { yaml: null, registered: [], warnings: [] };
  }
  const { yaml } = parseAgentsYaml(text);
  if (yaml === null) return { yaml: null, registered: [], warnings: [] };
  return { yaml, ...registerAgentsYaml(yaml) };
}

/**
 * 驱动解析叠加层：agents.yaml 条目优先，未命中退回全局 registry（resolveDriver）。
 * template 形态在此构造 HeadlessDriver（可带 bin/env 覆盖）；acp 形态构造 AcpDriver。
 */
export function resolveWithAgentsYaml(
  yaml: AgentsYaml | null,
): (name: string) => AgentDriver {
  return (name: string): AgentDriver => {
    const entry = yaml?.agents[name];
    if (entry === undefined) return resolveDriver(name);
    if (entry.kind === "acp") {
      return new AcpDriver({
        bin: entry.bin,
        args: entry.args ?? ["acp"],
        name: `acp:${name}`,
        ...(entry.env !== undefined ? { env: entry.env } : {}),
      });
    }
    return new HeadlessDriver({
      cli: entry.template ?? name,
      bin: entry.bin,
      name: `headless:${name}`,
      ...(entry.env !== undefined ? { env: entry.env } : {}),
    });
  };
}
