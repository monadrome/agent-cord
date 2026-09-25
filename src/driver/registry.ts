/**
 * 驱动解析（ADR-0017 注意点 5 的探测顺序：ACP → 厂商直连/裸 headless → 报错）。
 *
 * PTY 兜底未实现（ADR-0017 决策：仅对无任何结构化接口的 agent 作最后兜底，需显式配置开启）。
 * 显式覆盖：`acp:<agent>` / `headless:<agent>` 跳过探测。
 */
import { execa } from "execa";
import type { AgentDriver } from "../core/ports.js";
import { AcpDriver } from "./acp.js";
import { HeadlessDriver, getHeadlessCliTemplate, listHeadlessCliTemplates } from "./headless.js";

export interface KnownAgent {
  /** agent 二进制原生支持 `acp` 子命令（ADR-0017：ACP 覆盖优先走这条） */
  acp?: { bin: string; args: string[] };
  /**
   * 需要另装 ACP 适配器才说 ACP 的 agent（如 claude-agent-acp / codex-acp）：
   * 默认不占用探测顺序，只在显式 `acp:<name>` 时使用（ADR-0017 决策 1 的「能力上限通道」）。
   */
  acp_adapter?: { bin: string; args: string[] };
  /** 裸 headless 降级通道用的参数模板名 */
  headless?: string;
}

const knownAgents = new Map<string, KnownAgent>([
  // 原生 `kimi acp`（ACP registry 条目 kimi）
  ["kimi", { acp: { bin: "kimi", args: ["acp"] }, headless: "kimi" }],
  // claude / codex 无原生 ACP：默认走直连适配器（claude -p / codex exec），
  // 显式 `acp:claude` 时才走官方 ACP 适配器二进制
  ["claude", { acp_adapter: { bin: "claude-agent-acp", args: [] }, headless: "claude" }],
  ["codex", { acp_adapter: { bin: "codex-acp", args: [] }, headless: "codex" }],
  ["opencode", { acp: { bin: "opencode", args: ["acp"] } }],
]);

export function registerKnownAgent(name: string, agent: KnownAgent): void {
  knownAgents.set(name, agent);
}

export function getKnownAgent(name: string): KnownAgent | undefined {
  return knownAgents.get(name);
}

export function listKnownAgents(): string[] {
  return [...knownAgents.keys()].sort();
}

export interface ResolveDriverOptions {
  /**
   * ACP 能力探测钩子。默认 `() => true`：按已知 agent 清单里的声明走 ACP。
   * 宿主可用 detectAcpSupport 实测后传 `() => false`（例如 agent 装了但没编 acp 子命令）来强制降级。
   * 不在这里直接 spawn：resolveDriver 是同步的，探测结果应由宿主缓存后注入。
   */
  supportsAcp?: (name: string) => boolean;
  /** 透传给 driver 的环境变量（BYO 凭证：daemon 只透传，不代管凭据） */
  env?: Record<string, string>;
}

function splitPrefixed(name: string): { prefix: string | undefined; target: string } {
  const index = name.indexOf(":");
  if (index === -1) return { prefix: undefined, target: name };
  return { prefix: name.slice(0, index), target: name.slice(index + 1) };
}

function acpDriverFor(
  agentName: string,
  agent: KnownAgent | undefined,
  env: Record<string, string> | undefined,
): AgentDriver {
  const spec = agent?.acp ?? agent?.acp_adapter;
  if (spec !== undefined) {
    return new AcpDriver({
      bin: spec.bin,
      args: spec.args,
      name: `acp:${agentName}`,
      ...(env !== undefined ? { env } : {}),
    });
  }
  // 未登记启动方式：把名字当二进制，默认子命令 `acp`
  return new AcpDriver({ bin: agentName, name: `acp:${agentName}`, ...(env !== undefined ? { env } : {}) });
}

function headlessDriverFor(
  templateName: string,
  env: Record<string, string> | undefined,
): HeadlessDriver | undefined {
  if (getHeadlessCliTemplate(templateName) === undefined) return undefined;
  return new HeadlessDriver({ cli: templateName, ...(env !== undefined ? { env } : {}) });
}

/**
 * 把 agent 名解析为驱动实例。
 *
 * - 裸名：ACP 优先（该 agent 声明支持 `acp` 子命令）→ 裸 headless 模板 → 抛错
 * - `acp:<agent>` / `headless:<agent>`：显式指定通道，跳过探测
 */
export function resolveDriver(name: string, options: ResolveDriverOptions = {}): AgentDriver {
  const { prefix, target } = splitPrefixed(name);
  if (target.length === 0) {
    throw new Error(`invalid driver name "${name}": expected <agent>, acp:<agent> or headless:<agent>`);
  }

  const agent = getKnownAgent(target);

  if (prefix === "acp") return acpDriverFor(target, agent, options.env);

  if (prefix === "headless") {
    const driver = headlessDriverFor(target, options.env);
    if (driver === undefined) {
      throw new Error(
        `unknown headless CLI "${target}"; known templates: ${listHeadlessCliTemplates().join(", ")}`,
      );
    }
    return driver;
  }

  if (prefix !== undefined) {
    throw new Error(
      `unknown driver prefix "${prefix}" in "${name}": expected acp: or headless:`,
    );
  }

  const supportsAcp = options.supportsAcp ?? (() => true);
  if (agent?.acp !== undefined && supportsAcp(target)) {
    return acpDriverFor(target, agent, options.env);
  }

  const headless = headlessDriverFor(agent?.headless ?? target, options.env);
  if (headless !== undefined) return headless;

  const acpReason =
    agent?.acp !== undefined ? "ACP declined by the supportsAcp probe" : "no ACP entry";
  throw new Error(
    `no driver for "${target}": ${acpReason}, no headless template. ` +
      `known agents: ${listKnownAgents().join(", ")}; known headless templates: ${listHeadlessCliTemplates().join(", ")}. ` +
      `Use "headless:<name>" after registering a template, or "acp:<agent>" for an ACP-capable agent.`,
  );
}

/**
 * 实测二进制是否提供 `acp` 子命令（读 `--help`；不联网、不改状态）。
 * 供宿主在启动时探测一次并缓存，结果经 ResolveDriverOptions.supportsAcp 注入。
 */
export async function detectAcpSupport(
  bin: string,
  prefixArgs: string[] = [],
  timeoutMs: number = 5_000,
): Promise<boolean> {
  try {
    const result = await execa(bin, [...prefixArgs, "--help"], {
      reject: false,
      timeout: timeoutMs,
    });
    return /\bacp\b/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  } catch {
    return false;
  }
}
