/**
 * 工作区级 agent 配置（ADR-0023/0027）：ACP / headless 模板 / 自定义 args。
 * 解析与编译不修改全局模板表；每个 resolver 是固定配置快照。
 * 文件整体错误拒绝加载，单条错误告警并阻断该别名，避免误用同名内置 agent。
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentDriver } from "../core/ports.js";
import { AcpDriver } from "./acp.js";
import { AcpPermissionPolicySchema } from "./acp-permissions.js";
import { AgentLaunchSchema } from "./launch.js";
import { custom_headless_template } from "./custom-template.js";
import {
  HeadlessDriver,
  getHeadlessCliTemplate,
  listHeadlessCliTemplates,
  type AgentKnob,
  type HeadlessKnobs,
} from "./headless.js";
import { getKnownAgent, listKnownAgents, resolveDriver } from "./registry.js";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KNOB_KEYS = ["provider", "model", "effort", "max_turns", "budget_usd", "system_prompt", "agent", "agents_json"] as const;

const AgentEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("acp"),
    bin: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    context_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    permission_policy: AcpPermissionPolicySchema.optional(),
    launch: AgentLaunchSchema.optional(),
    readonly_launch: AgentLaunchSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("headless"),
    template: z.string().min(1).optional(),
    /** 模板形态可省略二进制；自定义 args 形态必须声明 */
    bin: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    resume_args: z.array(z.string()).optional(),
    readonly_args: z.array(z.string()).optional(),
    readonly_resume_args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    context_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    max_turns: z.number().int().positive().optional(),
    budget_usd: z.number().positive().optional(),
    system_prompt: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    agents_json: z.string().min(1).optional(),
    launch: AgentLaunchSchema.optional(),
  }),
]);

const AgentsYamlSchema = z.object({
  agents: z.record(z.string(), AgentEntrySchema),
  /** 解析诊断元数据，不从配置文件直接接收 */
  rejected: z.array(z.string()).optional(),
});
export type AgentsYaml = z.infer<typeof AgentsYamlSchema>;

export interface AgentsLoadResult {
  registered: string[];
  warnings: string[];
  /** 配置无效的别名：解析时必须失败，不能退回同名内置 driver */
  rejected: string[];
}

/** 仅公开配置元信息；不携带 env、args、角色 prompt 或 agents_json */
export interface AgentDefinitionInfo {
  name: string;
  kind: "acp" | "headless";
  source: "workspace" | "registry";
  template: string | null;
  /** ADR-0054：公开的外部行为版本声明，不是环境摘要。 */
  context_revision?: number;
  permission_policy?: { read_count: number; edit_count: number };
}

export interface AgentRegistry extends AgentsLoadResult {
  resolve(name: string): AgentDriver;
  list(): AgentDefinitionInfo[];
}

/** 逐项诊断，不把 YAML 原文片段写进错误（可能含 BYO 凭据）。 */
export function parseAgentsYaml(text: string): AgentsLoadResult & { yaml: AgentsYaml } {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false });
  } catch {
    throw new Error("agents.yaml 解析失败：请检查 YAML 语法");
  }
  const root = z.strictObject({ agents: z.record(z.string(), z.unknown()) }).safeParse(raw);
  if (!root.success) throw new Error("agents.yaml 不符合 schema：顶层必须是 agents 名称映射");

  const agents: AgentsYaml["agents"] = Object.create(null) as AgentsYaml["agents"];
  const warnings: string[] = [];
  const rejected: string[] = [];
  for (const [name, entry] of Object.entries(root.data.agents)) {
    if (!AGENT_NAME.test(name)) {
      warnings.push(`agents.${name}: 名称只允许小写字母数字和连字符，长度 1-64，跳过注册`);
      rejected.push(name);
      continue;
    }
    const parsed = AgentEntrySchema.safeParse(entry);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) =>
        `agents.${name}${issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : ""}: ${issue.message}`,
      ).join("；");
      warnings.push(`${detail}，跳过注册`);
      rejected.push(name);
      continue;
    }
    agents[name] = parsed.data;
  }
  return { yaml: { agents, rejected }, registered: [], warnings, rejected };
}

function compileAgentsYaml(yaml: AgentsYaml | null): {
  drivers: Map<string, AgentDriver>;
  entries: AgentDefinitionInfo[];
  warnings: string[];
  rejected: string[];
} {
  const drivers = new Map<string, AgentDriver>();
  const entries: AgentDefinitionInfo[] = [];
  const warnings: string[] = [];
  const rejected: string[] = [];
  for (const [name, entry] of Object.entries(yaml?.agents ?? {})) {
    try {
      if (entry.kind === "acp") {
        drivers.set(name, new AcpDriver({
          bin: entry.bin,
          args: [...(entry.args ?? ["acp"])],
          name: `acp:${name}`,
          ...(entry.context_revision === undefined ? {} : { context_revision: entry.context_revision }),
          ...(entry.permission_policy === undefined ? {} : { permission_policy: entry.permission_policy }),
          ...(entry.launch === undefined ? {} : { launch: entry.launch }),
          ...(entry.readonly_launch === undefined ? {} : { readonly_launch: entry.readonly_launch }),
          ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
        }));
        entries.push({ name, kind: "acp", source: "workspace", template: null, ...(entry.context_revision === undefined ? {} : { context_revision: entry.context_revision }),
          ...(entry.permission_policy === undefined ? {} : { permission_policy: { read_count: entry.permission_policy.read.length, edit_count: entry.permission_policy.edit.length } }) });
        continue;
      }
      if ((entry.template === undefined) === (entry.args === undefined)) {
        warnings.push(`agents.${name}: headless 需要 template 或 args 之一，且不能同时声明，跳过注册`);
        rejected.push(name);
        continue;
      }
      if (entry.template !== undefined) {
        if (entry.resume_args !== undefined || entry.readonly_args !== undefined || entry.readonly_resume_args !== undefined) throw new Error("模板形态不能声明自定义参数分支");
        const template = getHeadlessCliTemplate(entry.template);
        if (template === undefined) {
          warnings.push(`agents.${name}: 未知 headless 模板 "${entry.template}"，跳过注册`);
          rejected.push(name);
          continue;
        }
        const supported = new Set<AgentKnob>(template.knobs ?? []);
        const knobs: HeadlessKnobs = {};
        for (const key of KNOB_KEYS) {
          const value = entry[key];
          if (value === undefined) continue;
          if (!supported.has(key)) {
            throw new Error(`模板不支持旋钮 ${key}`);
          } else {
            (knobs as Record<string, unknown>)[key] = value;
          }
        }
        drivers.set(name, new HeadlessDriver({
          cli: entry.template,
          template,
          ...(entry.bin !== undefined ? { bin: entry.bin } : {}),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
          name: `headless:${name}`,
          knobs,
          ...(entry.launch === undefined ? {} : { launch: entry.launch }),
          ...(entry.context_revision === undefined ? {} : { context_revision: entry.context_revision }),
        }));
      } else {
        if (entry.bin === undefined) {
          warnings.push(`agents.${name}.bin: 自定义 args 形态必须声明二进制，跳过注册`);
          rejected.push(name);
          continue;
        }
        const args = [...entry.args!];
        const used = KNOB_KEYS.filter((key) => entry[key] !== undefined);
        if (used.length > 0) {
          throw new Error(`自定义 args 旋钮须改用 launch 与显式占位符：${used.join("/")}`);
        }
        drivers.set(name, new HeadlessDriver({
          cli: name,
          template: custom_headless_template(name, entry.bin, args, entry.resume_args, {
            ...(entry.readonly_args === undefined ? {} : { readonly_args: entry.readonly_args }),
            ...(entry.readonly_resume_args === undefined ? {} : { readonly_resume_args: entry.readonly_resume_args }),
          }),
          ...(entry.launch === undefined ? {} : { launch: entry.launch }),
          ...(entry.env !== undefined ? { env: entry.env } : {}),
          name: `headless:${name}`,
          ...(entry.context_revision === undefined ? {} : { context_revision: entry.context_revision }),
        }));
      }
      entries.push({ name, kind: "headless", source: "workspace", template: entry.template ?? null, ...(entry.context_revision === undefined ? {} : { context_revision: entry.context_revision }) });
    } catch (error) {
      drivers.delete(name);
      rejected.push(name);
      warnings.push(`agents.${name}: ${error instanceof Error ? error.message : "启动配置无效"}，跳过注册`);
    }
  }
  return { drivers, entries, warnings, rejected };
}

/** 保留旧入口用于配置检查；ADR-0027 起不再污染全局模板表。 */
export function registerAgentsYaml(yaml: AgentsYaml): AgentsLoadResult {
  const compiled = compileAgentsYaml(yaml);
  return {
    registered: [...compiled.drivers.keys()],
    warnings: compiled.warnings,
    rejected: [...new Set([...(yaml.rejected ?? []), ...compiled.rejected])],
  };
}

export async function loadAgentsFile(path: string): Promise<AgentsLoadResult & { yaml: AgentsYaml | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { yaml: null, registered: [], warnings: [], rejected: [] };
    }
    throw new Error("agents.yaml 读取失败：请检查文件类型与访问权限");
  }
  const parsed = parseAgentsYaml(text);
  const checked = registerAgentsYaml(parsed.yaml);
  return {
    yaml: parsed.yaml,
    registered: checked.registered,
    warnings: [...parsed.warnings, ...checked.warnings],
    rejected: checked.rejected,
  };
}

/** 工作区 resolver 快照：固定所有可用 driver，显式前缀也遵循同一工作区配置。 */
export function createAgentRegistry(yaml: AgentsYaml | null, rejectedNames: readonly string[] = []): AgentRegistry {
  const compiled = compileAgentsYaml(yaml);
  const rejected = new Set([...(yaml?.rejected ?? []), ...rejectedNames, ...compiled.rejected]);
  const drivers = new Map<string, AgentDriver>();
  const entries = new Map<string, AgentDefinitionInfo>();
  const names = new Set([...listKnownAgents(), ...listHeadlessCliTemplates()]);
  for (const name of names) {
    const candidates = [name];
    if (getHeadlessCliTemplate(name) !== undefined) candidates.push(`headless:${name}`);
    const known = getKnownAgent(name);
    if (known?.acp !== undefined || known?.acp_adapter !== undefined) candidates.push(`acp:${name}`);
    for (const candidate of candidates) {
      try {
        const driver = resolveDriver(candidate);
        drivers.set(candidate, driver);
        entries.set(candidate, {
          name: candidate,
          kind: driver instanceof AcpDriver ? "acp" : "headless",
          source: "registry",
          template: driver instanceof HeadlessDriver ? known?.headless ?? name : null,
        });
      } catch {
        // 仅有显式通道的注册条目不一定支持裸名。
      }
    }
  }
  for (const entry of compiled.entries) entries.set(entry.name, entry);
  for (const [candidate] of entries) {
    const target = candidate.includes(":") ? candidate.slice(candidate.indexOf(":") + 1) : candidate;
    if (rejected.has(target) || (compiled.drivers.has(target) && candidate.includes(":"))) {
      entries.delete(candidate);
    }
  }
  return {
    registered: [...compiled.drivers.keys()],
    warnings: compiled.warnings,
    rejected: [...rejected],
    list: () => [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ ...entry,
      ...(entry.permission_policy === undefined ? {} : { permission_policy: { ...entry.permission_policy } }) })),
    resolve(name: string): AgentDriver {
      const index = name.indexOf(":");
      const prefix = index === -1 ? undefined : name.slice(0, index);
      const target = index === -1 ? name : name.slice(index + 1);
      if (rejected.has(target)) throw new Error(`agent "${target}" 配置无效，请修正 agents.yaml 后重载`);
      const local = compiled.drivers.get(target);
      if (local !== undefined) {
        const kind = local instanceof AcpDriver ? "acp" : "headless";
        if (prefix !== undefined && prefix !== kind) {
          throw new Error(`agent "${target}" 使用 ${kind} 通道，不能以 ${prefix}: 启动`);
        }
        return local;
      }
      const driver = drivers.get(name);
      if (driver !== undefined) return driver;
      if (prefix === "acp" && target.length > 0) {
        return new AcpDriver({ bin: target, name });
      }
      throw new Error(`no driver for "${name}"：请检查驱动名称或 agents.yaml 配置`);
    },
  };
}

export function resolveWithAgentsYaml(yaml: AgentsYaml | null, rejectedNames: readonly string[] = []): (name: string) => AgentDriver {
  return createAgentRegistry(yaml, rejectedNames).resolve;
}
