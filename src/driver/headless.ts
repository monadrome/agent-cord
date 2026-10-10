/**
 * 裸 headless 驱动（ADR-0011「每任务 subprocess」；ADR-0017 探测顺序的第二层）。
 *
 * 形态：一次任务 = 一个 CLI 进程（execa spawn，独立 cwd/env）→ 读 stdout 的结构化事件流
 * （stream-json / JSONL）→ 映射为 AgentEvent → 进程退出即弃；resume 走各家会话恢复参数。
 *
 * 本文件同时承载两个 driver 共用的最小运行时工具（异步队列、进程树终止、事件构造函数），
 * acp.ts 直接复用，避免在 src/driver 下再增一个内部模块。
 */
import { execa } from "execa";
import type { AgentDriver, AgentEvent, AgentTask } from "../core/ports.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { validate_agent_launch, type AgentCapabilities, type AgentLaunch } from "./launch.js";

// ---------------------------------------------------------------------------
// 事件数据约定（AgentEvent.data 的具体形态）
//
// 两个 driver 统一在 data 里给出以下形状，并在 raw 中原样保留上游事件（不损失粒度）；
// 运行流回填统一 session_id 回执；终态 data 保留兼容槽位（ADR-0037）。
// ---------------------------------------------------------------------------

export type DriverErrorKind =
  | "timeout"
  | "spawn"
  | "agent"
  | "permission"
  | "configuration"
  | "protocol";

export interface TextEventData {
  text: string;
  /** ADR-0029：辅助协议/思考文本不参与 coordinator 产物拼接；缺省 content */
  channel?: "content" | "metadata";
  raw?: unknown;
}

export interface ToolUseEventData {
  name: string | null;
  input: unknown;
  raw?: unknown;
}

/**
 * 规范化用量（ADR-0023 决策 3 的 usage 槽位）：各厂商原始字段映射到统一口径，
 * 原始负载仍留在 raw 里不丢粒度。
 */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** 命中缓存的输入 token（claude cache_read_input_tokens / codex cached_input_tokens / ACP cachedReadInputTokens） */
  cached_input_tokens?: number;
  /** 成本（美元）；目前仅 claude 原生提供 total_cost_usd */
  cost_usd?: number;
  /** agent 轮次（claude num_turns） */
  num_turns?: number;
}

export interface ResultEventData {
  /** 最终结果文本；空字符串保留明确空结果，null 表示无显式文本 */
  text: string | null;
  /** 会话 id：运行流维护回执，data 与 AgentEvent.session_id 均供宿主读取 */
  session_id: string | null;
  usage?: AgentUsage | null;
  raw?: unknown;
}

export interface ErrorEventData {
  message: string;
  kind: DriverErrorKind;
  session_id?: string | null;
  raw?: unknown;
}

export function textEvent(text: string, raw?: unknown, channel?: TextEventData["channel"]): AgentEvent {
  const data: TextEventData = raw === undefined ? { text } : { text, raw };
  if (channel !== undefined) data.channel = channel;
  return { type: "text", data };
}

export function toolUseEvent(name: string | null, input: unknown, raw?: unknown): AgentEvent {
  const data: ToolUseEventData = raw === undefined ? { name, input } : { name, input, raw };
  return { type: "tool_use", data };
}

export function resultEvent(
  text: string | null,
  sessionId: string | null,
  raw?: unknown,
  usage?: AgentUsage | null,
): AgentEvent {
  const data: ResultEventData = { text, session_id: sessionId };
  if (usage !== undefined) data.usage = usage;
  if (raw !== undefined) data.raw = raw;
  return { type: "result", data };
}

export function errorEvent(
  message: string,
  kind: DriverErrorKind,
  extra: { session_id?: string | null; raw?: unknown } = {},
): AgentEvent {
  const data: ErrorEventData = { message, kind };
  if (extra.session_id !== undefined) data.session_id = extra.session_id;
  if (extra.raw !== undefined) data.raw = extra.raw;
  return { type: "error", data };
}

// ---------------------------------------------------------------------------
// 共用运行时工具
// ---------------------------------------------------------------------------

/** 无超时上限时的默认 wall-clock 预算（ADR-0011 第二层防线：平台侧超时） */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** SIGTERM 之后等多久再 SIGKILL 兜底 */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** 够用的进程句柄结构（execa subprocess 与 ChildProcess 都满足） */
export interface KillableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * 最小异步队列：把回调式事件源（子进程 stdout / JSON-RPC 通知）转成 async iterable。
 * 消费端 `for await` 到 close() 为止；close() 之后 push 的元素直接丢弃。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * 杀进程树。子进程以 `detached: true` 启动 → 自己是进程组组长，
 * `kill(-pid)` 覆盖其全部后代；不是组长（或已退出）时退回单进程 kill。
 */
export function killProcessTree(child: KillableProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 非进程组（未 detached / 已回收）→ 退回单进程
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已退出
  }
}

/**
 * 带退出状态的进程句柄。
 * execa v10 的 subprocess 不暴露 exitCode/signalCode，退出状态必须由调用方
 * 用同一个 result promise 维护（见 trackProcess）。
 */
export interface ProcessLifecycle extends KillableProcess {
  exited: boolean;
}

/** 把 execa 的 subprocess 包装成带退出状态的句柄（reject: false → 成功失败都算退出） */
export function trackProcess(child: KillableProcess & PromiseLike<unknown>): ProcessLifecycle {
  const lifecycle: ProcessLifecycle = {
    pid: child.pid,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    exited: false,
  };
  const mark = (): void => {
    lifecycle.exited = true;
  };
  void child.then(mark, mark);
  return lifecycle;
}

async function waitForExit(child: ProcessLifecycle, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exited) return true;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  return child.exited;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SIGTERM → 等待 grace → SIGKILL；已经退出的进程直接返回 */
export async function terminateProcessTree(
  child: ProcessLifecycle,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<void> {
  if (child.exited) return;
  killProcessTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) return;
  killProcessTree(child, "SIGKILL");
  await waitForExit(child, graceMs);
}

// ---------------------------------------------------------------------------
// stream-json / JSONL 解析
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const SESSION_ID_KEYS = ["session_id", "sessionId", "thread_id", "threadId"] as const;

/** 从各家事件形态里抽会话 id（claude: session_id / codex: thread_id / kimi: 无） */
export function extractSessionId(value: Record<string, unknown>): string | null {
  for (const key of SESSION_ID_KEYS) {
    const found = asString(value[key]);
    if (found !== undefined) return found;
  }
  if (isRecord(value.item)) return extractSessionId(value.item);
  return null;
}

function extractMessage(value: Record<string, unknown>): string {
  const direct = asString(value.message) ?? asString(value.result) ?? asString(value.error);
  if (direct !== undefined) return direct;
  if (isRecord(value.error)) {
    const nested = asString(value.error.message);
    if (nested !== undefined) return nested;
  }
  return JSON.stringify(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 从终局事件提取规范化用量：claude `result`（usage + total_cost_usd + num_turns）、
 * codex `turn.completed`（usage.cached_input_tokens）等 snake_case 形态；
 * 全空时返回 null（不硬造 0——厂商没报就是未知）。
 */
export function extractUsage(value: Record<string, unknown>): AgentUsage | null {
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const usage: AgentUsage = {
    input_tokens: asNumber(rawUsage?.input_tokens),
    output_tokens: asNumber(rawUsage?.output_tokens),
    cached_input_tokens:
      asNumber(rawUsage?.cached_input_tokens) ?? asNumber(rawUsage?.cache_read_input_tokens),
    cost_usd: asNumber(value.total_cost_usd),
    num_turns: asNumber(value.num_turns),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function mapContentBlocks(content: unknown, channel?: TextEventData["channel"]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of asArray(content)) {
    if (!isRecord(block)) continue;
    const kind = asString(block.type);
    if (kind === "text") {
      const text = asString(block.text);
      if (text !== undefined) events.push(textEvent(text, block, channel));
      continue;
    }
    if (kind === "tool_use") {
      events.push(toolUseEvent(asString(block.name) ?? null, block.input ?? null, block));
      continue;
    }
    if (kind === "tool_result") {
      events.push(toolUseEvent(null, block, block));
    }
  }
  return events;
}

/**
 * 单行 → 0..n 个 AgentEvent。
 * 无法解析的行（非 JSON / 非对象）按 text 事件透传；能解析但形态陌生的事件也按 text 透传并保留 raw。
 */
export function parseHeadlessLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [textEvent(trimmed)];
  }
  if (!isRecord(value)) return [textEvent(trimmed)];

  const sessionId = extractSessionId(value);
  const type = asString(value.type);
  const role = asString(value.role);

  // 终局事件：claude `type:"result"`、codex `type:"turn.completed"`
  if (type === "result" || type === "turn.completed" || type === "result.completed") {
    const subtype = asString(value.subtype);
    if (value.is_error === true || (subtype !== undefined && subtype !== "success")) {
      return [errorEvent(extractMessage(value), "agent", { session_id: sessionId, raw: value })];
    }
    const text = typeof value.result === "string" ? value.result : typeof value.text === "string" ? value.text : null;
    return [resultEvent(text, sessionId, value, extractUsage(value))];
  }

  if (type === "turn.failed" || type === "error" || value.is_error === true) {
    return [errorEvent(extractMessage(value), "agent", { session_id: sessionId, raw: value })];
  }

  if (type === "system" || type === "thread.started" || type === "turn.started" || role === "meta" || role === "user") {
    return [textEvent(trimmed, value, "metadata")];
  }

  // kimi stream-json：OpenAI chat 形态的 JSONL（role: assistant / tool / meta）
  if (role === "assistant" || role === "tool") {
    const events: AgentEvent[] = [];
    if (role === "assistant") {
      const text = asString(value.content);
      if (text !== undefined) events.push(textEvent(text, value));
      for (const call of asArray(value.tool_calls)) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : undefined;
        events.push(
          toolUseEvent(asString(fn?.name) ?? null, fn?.arguments ?? null, call),
        );
      }
    } else {
      events.push(
        toolUseEvent(
          null,
          { tool_call_id: value.tool_call_id ?? null, content: value.content ?? null },
          value,
        ),
      );
    }
    if (events.length > 0) return events;
  }

  // claude 事件流：{type:"assistant"|"user", message:{content:[...]}}
  if ((type === "assistant" || type === "user") && isRecord(value.message)) {
    const events = mapContentBlocks(value.message.content, type === "user" ? "metadata" : undefined);
    if (events.length > 0) return events;
  }

  // codex `exec --json`：{type:"item.completed", item:{type:"agent_message"|...}}
  if (type !== undefined && type.startsWith("item.") && isRecord(value.item)) {
    const item = value.item;
    const itemType = asString(item.type) ?? "";
    if (itemType === "error" || itemType === "warning") {
      return [textEvent(extractMessage(item), item, "metadata")];
    }
    if (itemType === "agent_message" || itemType === "reasoning" || itemType === "plan") {
      const text = typeof item.text === "string" ? item.text : "";
      return [textEvent(text, item, itemType === "agent_message" ? undefined : "metadata")];
    }
    if (itemType === "file_change" || /tool|command|function_call|patch/i.test(itemType)) {
      return [
        toolUseEvent(
          asString(item.name) ?? itemType,
          item.arguments ?? item.command ?? item.input ?? item.changes ?? null,
          item,
        ),
      ];
    }
  }

  // 形态陌生但可解析：保留原文与原始对象（不丢信息）
  return [textEvent(trimmed, value)];
}

// ---------------------------------------------------------------------------
// CLI 参数模板
// ---------------------------------------------------------------------------

export interface HeadlessArgInput {
  prompt: string;
  readonly: boolean;
  resume_session_id?: string | undefined;
  /** 模型选择（claude --model / codex -m / kimi -m） */
  model?: string | undefined;
  /** 推理强度（claude --effort / codex -c model_reasoning_effort） */
  effort?: string | undefined;
  /** 轮次上限（claude --max-turns，print 模式） */
  max_turns?: number | undefined;
  /** 预算上限美元（claude --max-budget-usd，print 模式） */
  budget_usd?: number | undefined;
  /** 角色封装：追加系统提示（claude --append-system-prompt） */
  system_prompt?: string | undefined;
  /** 硬封装：整个会话以指定 subagent 身份运行（claude --agent <name>，继承其 prompt/tools/model/权限） */
  agent?: string | undefined;
  /** 免写盘注入 subagent 定义（claude --agents <json>；与 agent 搭配使用） */
  agents_json?: string | undefined;
  bare?: boolean | undefined;
  auto?: boolean | undefined;
}

/** 显式旋钮必须被模板声明，否则拒绝启动。 */
export type AgentKnob =
  | "model"
  | "effort"
  | "max_turns"
  | "budget_usd"
  | "system_prompt"
  | "agent"
  | "agents_json"
  | "bare"
  | "auto";

export interface HeadlessCliTemplate {
  /** 模板名：registry 用它把 agent 名映射到驱动参数 */
  readonly name: string;
  /** 默认二进制名 */
  readonly bin: string;
  /** 支持的旋钮清单；缺省视为全不支持（保守） */
  readonly knobs?: readonly AgentKnob[];
  /** 自定义模板缺省不承诺能恢复；内置模板显式声明。 */
  readonly supports_resume?: boolean;
  args(input: HeadlessArgInput): string[];
}

/** 评审票只给只读工具（ADR-0011 注意点 3：读文件 + git diff/log 类） */
const CLAUDE_READONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
];

const BUILTIN_TEMPLATES: readonly HeadlessCliTemplate[] = [
  {
    // kimi -p --output-format stream-json（JSONL 为 OpenAI chat 形态：role assistant/tool/meta）
    name: "kimi",
    bin: "kimi",
    knobs: ["model"],
    supports_resume: true,
    args: ({ prompt, readonly, resume_session_id, model }) => [
      ...(resume_session_id !== undefined ? ["--session", resume_session_id] : []),
      // readonly：plan 模式只出计划不改文件；无人值守时不会弹交互审批
      ...(readonly ? ["--plan"] : []),
      ...(model !== undefined ? ["--model", model] : []),
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ],
  },
  {
    // claude -p --output-format stream-json（直接适配器；Claude 无原生 ACP，见 ADR-0017 决策 1）
    name: "claude",
    bin: "claude",
    knobs: ["model", "effort", "max_turns", "budget_usd", "system_prompt", "agent", "agents_json", "bare", "auto"],
    supports_resume: true,
    args: ({
      prompt,
      readonly,
      resume_session_id,
      model,
      effort,
      max_turns,
      budget_usd,
      system_prompt,
      agent,
      agents_json,
      bare,
      auto,
    }) => [
      ...(bare === true ? ["--bare"] : []),
      ...(auto === true && !readonly ? ["--permission-mode", "auto"] : []),
      ...(resume_session_id !== undefined
        ? readonly
          ? ["--resume", resume_session_id, "--fork-session"] // 只读任务不污染原会话
          : ["--resume", resume_session_id]
        : []),
      ...(model !== undefined ? ["--model", model] : []),
      ...(effort !== undefined ? ["--effort", effort] : []),
      ...(max_turns !== undefined ? ["--max-turns", String(max_turns)] : []),
      ...(budget_usd !== undefined ? ["--max-budget-usd", String(budget_usd)] : []),
      ...(system_prompt !== undefined ? ["--append-system-prompt", system_prompt] : []),
      // 硬封装：--agents 注入定义（免写盘），--agent 强制主线程身份（继承 prompt/tools/权限）
      ...(agents_json !== undefined ? ["--agents", agents_json] : []),
      ...(agent !== undefined ? ["--agent", agent] : []),
      // --allowedTools 是可变参数，必须紧邻下一个选项，否则会吞掉后续位置参数（prompt）
      ...(readonly ? ["--permission-mode", "plan", "--allowedTools", ...CLAUDE_READONLY_TOOLS] : []),
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ],
  },
  {
    // codex exec --json（NDJSON 为 item/turn 事件流）
    name: "codex",
    bin: "codex",
    knobs: ["model", "effort"],
    supports_resume: true,
    args: ({ prompt, readonly, resume_session_id, model, effort }) => [
      "exec",
      ...(resume_session_id !== undefined ? ["resume", resume_session_id] : []),
      "--json",
      ...(model !== undefined ? ["--model", model] : []),
      // effort → codex 配置覆盖（codex 无 effort CLI 旗标）
      ...(effort !== undefined ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      // codex exec 默认 read-only 沙箱（已实证）：非只读任务必须显式 workspace-write，
      // 否则写文件被拦截且无审批交互（exec 无人值守）；`exec resume` 不收 -s，统一走 -c
      "-c",
      `sandbox_mode="${readonly ? "read-only" : "workspace-write"}"`,
      "-c",
      'approval_policy="never"',
      prompt,
    ],
  },
];

const templates = new Map<string, HeadlessCliTemplate>(
  BUILTIN_TEMPLATES.map((template) => [template.name, template]),
);

/** 注册自定义 CLI 参数模板（新增 agent 零代码：注册模板即可被 registry 解析） */
export function registerHeadlessCliTemplate(template: HeadlessCliTemplate): void {
  templates.set(template.name, template);
}

export function getHeadlessCliTemplate(name: string): HeadlessCliTemplate | undefined {
  return templates.get(name);
}

export function listHeadlessCliTemplates(): string[] {
  return [...templates.keys()].sort();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface HeadlessDriverOptions {
  /** 内置模板名（kimi / claude / codex）或 registerHeadlessCliTemplate 注册的模板名 */
  cli: string;
  /** 工作区私有模板（ADR-0027）：无需注册进全局表 */
  template?: HeadlessCliTemplate;
  /** 覆盖二进制（测试用 fixture / 自定义安装路径） */
  bin?: string;
  /** argv 前缀（如 [fixturePath]），排在模板参数之前 */
  prefixArgs?: string[];
  /** 追加/覆盖环境变量（BYO 凭证：daemon 只透传，不代管厂商凭据） */
  env?: Record<string, string>;
  /** ADR-0054：配置者维护的外部行为版本，不传入 argv。 */
  context_revision?: number;
  /** SIGTERM → SIGKILL 之间的等待 */
  kill_grace_ms?: number;
  /** 暴露给 registry 的驱动名，默认 `headless:<cli>` */
  name?: string;
  /** 参数旋钮；不支持的配置拒绝启动。 */
  knobs?: HeadlessKnobs;
  launch?: AgentLaunch;
}

/** 模板旋钮值集（HeadlessArgInput 里除 prompt/readonly/resume 外的部分） */
export type HeadlessKnobs = Partial<
  Pick<
    HeadlessArgInput,
    "model" | "effort" | "max_turns" | "budget_usd" | "system_prompt" | "agent" | "agents_json" | "bare" | "auto"
  >
>;

export class HeadlessDriver implements AgentDriver {
  readonly name: string;
  readonly configuration_hash: string;
  readonly capabilities: AgentCapabilities;
  private readonly template: HeadlessCliTemplate;
  private readonly bin: string;
  private readonly prefixArgs: string[];
  private readonly env: Record<string, string>;
  private readonly killGraceMs: number;
  private readonly knobs: HeadlessKnobs;

  constructor(options: HeadlessDriverOptions) {
    if (options.context_revision !== undefined && (!Number.isSafeInteger(options.context_revision) || options.context_revision <= 0)) throw new Error("context_revision 必须是正安全整数");
    const template = options.template ?? getHeadlessCliTemplate(options.cli);
    if (template === undefined) {
      throw new Error(
        `unknown headless CLI "${options.cli}"; known: ${listHeadlessCliTemplates().join(", ")}`,
      );
    }
    this.template = { ...template, ...(template.knobs === undefined ? {} : { knobs: [...template.knobs] }) };
    this.bin = options.bin ?? template.bin;
    this.prefixArgs = [...(options.prefixArgs ?? [])];
    this.env = { ...options.env };
    this.killGraceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
    const supported = template.knobs ?? [];
    const launch = validate_agent_launch(options.launch, supported);
    for (const key of Object.keys(options.knobs ?? {})) {
      if (!supported.includes(key as AgentKnob)) throw new Error(`agent 模板不支持旋钮：${key}`);
      if (key in launch && options.knobs![key as AgentKnob] !== launch[key as keyof AgentLaunch]) throw new Error(`启动选项重复且不一致：${key}`);
    }
    this.knobs = { ...options.knobs, ...launch } as HeadlessKnobs;
    this.capabilities = Object.freeze({ transport: "headless", evidence: "adapter", installation: "unchecked", launch_options: Object.freeze([...supported]),
      native_resume: template.supports_resume === true ? "supported" : "unsupported", goal: "host", workflow_resume: "authorized_unexited_goal" });
    this.name = options.name ?? `headless:${template.name}`;
    const config_task = { prompt: "cord.configuration.prompt", cwd: "" };
    this.configuration_hash = sha256Hex(canonicalJson({
      domain: options.context_revision === undefined ? "cord.agent-config.headless.v1" : "cord.agent-config.headless.v2",
      ...(options.context_revision === undefined ? {} : { context_revision: options.context_revision }),
      name: this.name,
      argv: this.buildArgv(config_task),
      readonly_argv: this.buildArgv({ ...config_task, readonly: true }),
      resume_argv: this.template.supports_resume === true ? this.buildArgv(config_task, "cord.configuration.session") : null,
      readonly_resume_argv: this.template.supports_resume === true ? this.buildArgv({ ...config_task, readonly: true }, "cord.configuration.session") : null,
    }));
  }

  run(task: AgentTask): AsyncIterable<AgentEvent> {
    return this.execute(task, undefined);
  }

  resume(sessionId: string, task: AgentTask): AsyncIterable<AgentEvent> {
    return this.execute(task, sessionId);
  }

  /** 该驱动实际拼出的 argv（含 bin），供 registry/doctor/测试观测 */
  buildArgv(task: AgentTask, resumeSessionId?: string): string[] {
    if (resumeSessionId !== undefined && (resumeSessionId.length === 0 || this.template.supports_resume !== true)) throw new Error("agent 不支持显式原生 session resume");
    return [
      this.bin,
      ...this.prefixArgs,
      ...this.template.args({
        prompt: task.prompt,
        readonly: task.readonly === true,
        resume_session_id: resumeSessionId,
        ...this.knobs,
      }),
    ];
  }

  private async *execute(task: AgentTask, resumeSessionId: string | undefined): AsyncIterable<AgentEvent> {
    const argv = this.buildArgv(task, resumeSessionId);
    const [bin = this.bin, ...args] = argv;
    const timeoutMs = task.timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS;

    const queue = new AsyncQueue<AgentEvent>();
    let timedOut = false;
    let sawResult = false;
    let active_session_id: string | null = resumeSessionId ?? null;
    const stderrTail: string[] = [];

    const child = execa(bin, args, {
      cwd: task.cwd,
      env: { ...process.env, ...this.env },
      // 进程组组长 → 超时可整树清理（CLI 常自带子进程/MCP server）
      detached: true,
      reject: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const proc = trackProcess(child);

    const push = (events: AgentEvent[]): void => {
      for (const event of events) {
        const data = isRecord(event.data) ? event.data : null;
        const receipt = event.session_id ?? (data === null ? null : extractSessionId(data) ?? (isRecord(data.raw) ? extractSessionId(data.raw) : null));
        if (typeof receipt === "string" && receipt.length > 0) active_session_id = receipt;
        if (event.type === "result") sawResult = true;
        queue.push(active_session_id === null ? event : {
          ...event, session_id: active_session_id,
          ...(data !== null && (event.type === "result" || event.type === "error") && data.session_id == null
            ? { data: { ...data, session_id: active_session_id } } : {}),
        });
      }
    };

    let sigkillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      push([errorEvent(`headless task timed out after ${timeoutMs}ms`, "timeout")]);
      killProcessTree(proc, "SIGTERM");
      sigkillTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), this.killGraceMs);
    }, timeoutMs);

    // ADR-0025：外部取消（run 取消）→ 立即杀进程树并关闭事件流。
    // 不能依赖消费方 break：async generator 暂停在 queue.next() 时 return() 会排队等
    // 当前 await 解决，静默中的子进程不产出事件 = 死锁直到超时。
    const onAbort = (): void => {
      push([errorEvent("task aborted by caller", "agent")]);
      queue.close();
      killProcessTree(proc, "SIGTERM");
      sigkillTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), this.killGraceMs);
    };
    if (task.signal !== undefined) {
      if (task.signal.aborted) onAbort();
      else task.signal.addEventListener("abort", onAbort, { once: true });
    }

    const pump = async (): Promise<void> => {
      const stderr = child.stderr;
      if (stderr !== null && stderr !== undefined) {
        void (async () => {
          try {
            for await (const chunk of stderr) {
              stderrTail.push(String(chunk));
              while (stderrTail.length > 50) stderrTail.shift();
            }
          } catch {
            // stderr 读取失败不影响主流程
          }
        })();
      }

      try {
        const stdout = child.stdout;
        if (stdout !== null && stdout !== undefined) {
          let buffer = "";
          for await (const chunk of stdout) {
            buffer += String(chunk);
            let index = buffer.indexOf("\n");
            while (index !== -1) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              push(parseHeadlessLine(line));
              index = buffer.indexOf("\n");
            }
          }
          if (buffer.trim().length > 0) push(parseHeadlessLine(buffer));
        }
      } catch {
        // 进程被杀导致的流中断不属于解析失败
      }

      let exitCode: number | undefined;
      let signal: NodeJS.Signals | undefined;
      let spawnFailure: string | undefined;
      try {
        const result = await child;
        exitCode = result.exitCode;
        signal = result.signal;
        if (result.failed && exitCode === undefined && signal === undefined) {
          spawnFailure = result.originalMessage ?? `failed to spawn ${bin}`;
        }
      } catch (error) {
        spawnFailure = `failed to spawn ${bin}: ${error instanceof Error ? error.message : String(error)}`;
      }

      if (spawnFailure !== undefined) {
        push([errorEvent(spawnFailure, "spawn")]);
      } else if (!timedOut && !sawResult && exitCode !== 0) {
        const tail = stderrTail.join("").trim();
        push([
          errorEvent(
            `cli exited with ${signal !== undefined ? `signal ${signal}` : `code ${String(exitCode)}`}` +
              (tail.length > 0 ? `: ${tail}` : ""),
            "agent",
          ),
        ]);
      }
    };

    void (async () => {
      try {
        await pump();
      } finally {
        clearTimeout(timeoutTimer);
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        task.signal?.removeEventListener("abort", onAbort);
        await terminateProcessTree(proc, this.killGraceMs);
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // 消费方提前 break：停掉仍在跑的 CLI，避免进程泄漏
      queue.close();
      clearTimeout(timeoutTimer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      task.signal?.removeEventListener("abort", onAbort);
      await terminateProcessTree(proc, this.killGraceMs);
    }
  }
}
