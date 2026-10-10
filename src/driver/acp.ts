/**
 * ACP 驱动（ADR-0017 决策：AgentDriver 第一实现 = ACP client）。
 *
 * 形态：agent 作为本进程的子进程（JSON-RPC 2.0 over stdio），
 * initialize → session/new（resume 走 session/load）→ session/prompt，
 * session/update 通知映射为 AgentEvent；session/request_permission 由本驱动应答。
 *
 * 防御性超时（ADR-0017 注意点 2）：permission request 有独立超时，永远给出应答，
 * 绝不让「子 agent 的 permission request 不转发」把整体挂死；prompt 全程另有 wall-clock 超时，
 * 到点先 session/cancel 再杀进程树。
 */
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientContext,
  type Implementation,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type SessionConfigOption,
  type SessionModeState,
  type Usage,
} from "@agentclientprotocol/sdk";
import { execa } from "execa";
import type { AgentDriver, AgentEvent, AgentTask } from "../core/ports.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { validate_agent_launch, type AgentCapabilities, type AgentLaunch } from "./launch.js";
import { ACP_LAUNCH_STATE_POLICY, AcpConfigResponseSchema, AcpLaunchConfigurationError, AcpLaunchState, type AcpCapabilityObservation } from "./acp-launch.js";
import { AcpPermissionPolicySchema, decideAcpWorkspacePermission, type AcpPermissionPolicy, type AcpPermissionPolicyInput } from "./acp-permissions.js";
import {
  AsyncQueue,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  delay,
  errorEvent,
  killProcessTree,
  resultEvent,
  terminateProcessTree,
  textEvent,
  toolUseEvent,
  trackProcess,
  type AgentUsage,
} from "./headless.js";

/** 客户端自称（daemon 不代管厂商凭据，这里只声明自己是谁） */
const CLIENT_INFO: Implementation = { name: "agent-cord", version: "0.0.0" };

/** permission request 的防御性超时默认值 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

/** 超时时 session/cancel 通知写完的等待上限（写完即杀，写不出去也不拖） */
const CANCEL_FLUSH_MS = 250;

/** 写完 cancel 后留给 agent 读一拍的余量，再 SIGTERM（避免 cancel 还压在管道里就被杀） */
const CANCEL_SETTLE_MS = 100;

// ---------------------------------------------------------------------------
// 权限请求
// ---------------------------------------------------------------------------

/** 对一次权限请求的裁决：选中某个 offer 的选项，或取消该请求 */
export type PermissionDecision = { optionId: string } | { cancelled: true };

export interface PermissionContext {
  /** 只读任务（评审票）：只读工具外的权限请求一律拒绝 */
  readonly: boolean;
}

export type PermissionDecider = (
  request: RequestPermissionRequest,
  context: PermissionContext,
) => PermissionDecision | Promise<PermissionDecision>;

const TIMED_OUT = Symbol("permission-timeout");

function defaultPermissionDecision(
  request: RequestPermissionRequest,
  readonly: boolean,
): PermissionDecision {
  if (readonly) {
    const reject = request.options.find(
      (option) => option.kind === "reject_once" || option.kind === "reject_always",
    );
    if (reject !== undefined) return { optionId: reject.optionId };
  }
  // M2 不接人工审批：非只读模式也取消（并上抛 error 事件），绝不静默放行
  return { cancelled: true };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// session/update → AgentEvent
// ---------------------------------------------------------------------------

function contentToText(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link" && typeof block.uri === "string") return block.uri;
  return "";
}

/**
 * 一个 session/update 通知 → 0..n 个 AgentEvent。
 * AgentEvent 只有 4 种 type，无对应类型也按 text 事件 + raw 透传，保证粒度不丢（ADR-0017 决策 2）。
 */
export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return [textEvent(contentToText(update.content), update)];
    case "agent_thought_chunk":
    case "user_message_chunk":
    case "compaction_summary_chunk":
      return [textEvent(contentToText(update.content), update, "metadata")];
    case "tool_call":
    case "tool_call_update":
      return [toolUseEvent(update.title ?? update.kind ?? null, update.rawInput ?? null, update)];
    default:
      return [textEvent("", update, "metadata")];
  }
}

/**
 * ACP Usage（规范标注 UNSTABLE，camelCase 汇总值）→ 规范化 AgentUsage。
 * ACP 没有成本与轮次概念，只映射 token 三槽位。
 */
export function mapAcpUsage(usage: Usage | null | undefined): AgentUsage | null {
  if (usage == null) return null;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(typeof usage.cachedReadTokens === "number"
      ? { cached_input_tokens: usage.cachedReadTokens }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface AcpDriverOptions {
  /** agent 二进制（如 kimi / opencode / claude-agent-acp） */
  bin: string;
  launch?: AgentLaunch;
  /** 子命令，默认 ["acp"] */
  args?: string[];
  /** 暴露给 registry 的驱动名，默认 `acp:<bin>` */
  name?: string;
  env?: Record<string, string>;
  /** ADR-0054：配置者维护的外部行为版本，不传入 argv。 */
  context_revision?: number;
  /** permission request 的防御性超时 */
  permission_timeout_ms?: number;
  /** SIGTERM → SIGKILL 之间的等待 */
  kill_grace_ms?: number;
  /** 自定义审批决策（M3 人工桥接挂载点）；缺省走 M2 规则：只读拒绝，否则取消并上抛 error */
  decidePermission?: PermissionDecider;
  /** ADR-0060：可写任务的 read/edit 范围预授权，与自定义裁决互斥。 */
  permission_policy?: AcpPermissionPolicyInput;
  /** 会话 id 回执（宿主也可从 `AgentEvent.session_id` / result 事件的 data 里取） */
  onSession?: (sessionId: string) => void;
}

export class AcpDriver implements AgentDriver {
  readonly name: string;
  readonly configuration_hash: string;
  readonly capabilities: AgentCapabilities = Object.freeze({ transport: "acp", evidence: "adapter", installation: "unchecked", inspection: "acp_handshake",
    launch_options: Object.freeze(["model", "effort", "mode", "option_ids", "config_options"]), native_resume: "negotiated", goal: "host", workflow_resume: "authorized_unexited_goal" });
  private readonly launch: AgentLaunch;
  /** agent 二进制（doctor / registry 观测用） */
  readonly bin: string;
  readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly permissionTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly decidePermission: PermissionDecider | undefined;
  private readonly permission_policy: AcpPermissionPolicy | undefined;
  private readonly onSession: ((sessionId: string) => void) | undefined;

  constructor(options: AcpDriverOptions) {
    if (options.context_revision !== undefined && (!Number.isSafeInteger(options.context_revision) || options.context_revision <= 0)) throw new Error("context_revision 必须是正安全整数");
    this.bin = options.bin;
    this.args = [...(options.args ?? ["acp"])];
    this.name = options.name ?? `acp:${options.bin}`;
    this.launch = validate_agent_launch(options.launch, this.capabilities.launch_options);
    for (const key of ["model", "effort"] as const) {
      if (this.launch[key] !== undefined && this.launch.option_ids?.[key] === undefined) throw new Error(`ACP ${key} 必须声明 option_ids.${key}`);
    }
    const ids = Object.values(this.launch.option_ids ?? {});
    if (new Set(ids).size !== ids.length) throw new Error("ACP 启动选项不能映射到相同配置 ID");
    if (ids.some(id => Object.hasOwn(this.launch.config_options ?? {}, id))) throw new Error("ACP 配置 ID 与启动选项映射重复");
    if (options.permission_policy !== undefined && options.decidePermission !== undefined) throw new Error("permission_policy 与 decidePermission 不能同时声明");
    this.permission_policy = options.permission_policy === undefined ? undefined : AcpPermissionPolicySchema.parse(options.permission_policy);
    this.configuration_hash = sha256Hex(canonicalJson({ domain: Object.keys(this.launch).length > 0 ? "cord.agent-config.acp.v5" : this.permission_policy !== undefined ? "cord.agent-config.acp.v3" : options.context_revision === undefined ? "cord.agent-config.acp.v1" : "cord.agent-config.acp.v2",
      ...(Object.keys(this.launch).length === 0 ? {} : { launch_state_policy: ACP_LAUNCH_STATE_POLICY }),
      ...(Object.keys(this.launch).length === 0 ? {} : { launch: this.launch }),
      ...(this.permission_policy === undefined ? {} : { permission_policy: this.permission_policy }),
      ...(options.context_revision === undefined ? {} : { context_revision: options.context_revision }), name: this.name, bin: this.bin, args: this.args }));
    this.env = { ...options.env };
    this.permissionTimeoutMs = options.permission_timeout_ms ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.killGraceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
    this.decidePermission = options.decidePermission;
    this.onSession = options.onSession;
  }

  run(task: AgentTask): AsyncIterable<AgentEvent> {
    return this.execute(task, undefined);
  }

  resume(sessionId: string, task: AgentTask): AsyncIterable<AgentEvent> {
    return this.execute(task, sessionId);
  }

  /** 只协商新 session 并校验启动配置，不发送 prompt 或请求工具。 */
  async inspect(cwd: string, timeout_ms = 5_000): Promise<AcpCapabilityObservation> {
    let observation: AcpCapabilityObservation | undefined;
    for await (const event of this.execute({ prompt: "", cwd, timeout_ms }, undefined, true)) {
      if (event.type === "error") throw new Error("ACP 能力协商或启动配置核验失败");
      if (event.type === "tool_use") throw new Error("ACP 能力查询不允许工具调用");
      if (event.type === "result") observation = (event.data as { raw: AcpCapabilityObservation }).raw;
    }
    if (observation === undefined) throw new Error("ACP 未返回能力协商结果");
    return observation;
  }

  private async *execute(task: AgentTask, resumeSessionId: string | undefined, inspect_only = false): AsyncIterable<AgentEvent> {
    const timeoutMs = task.timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS;
    const readonly = task.readonly === true;
    const queue = new AsyncQueue<AgentEvent>();

    // execa 的 stdin 与 ACP 的 writable 必须是同一个流的两端，但两端各自被一方 lock，
    // 因此用两侧各自的「对端」交接：SDK 拿 writable/readable，execa 拿 readable/writable。
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const fromAgent = new TransformStream<Uint8Array, Uint8Array>();

    let activeSessionId: string | undefined = resumeSessionId;
    let timedOut = false;
    let agentText = "";
    let launch_state: AcpLaunchState | undefined;
    let launch_failure: AcpLaunchConfigurationError | undefined;
    const assert_running = (): void => {
      if (launch_failure !== undefined) throw launch_failure;
      if (shutdown_promise !== undefined || task.signal?.aborted) throw new Error("ACP 执行已收束");
    };

    /** ACP 通知与终态统一回填会话回执，供恢复与宿主审计使用。 */
    const push = (events: AgentEvent[]): void => {
      for (const event of events) {
        const data = typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
          ? event.data as Record<string, unknown>
          : null;
        const sessionId = event.session_id ?? activeSessionId ?? (
          typeof data?.session_id === "string" && data.session_id.length > 0 ? data.session_id : null
        );
        queue.push(sessionId === null ? event : {
          ...event,
          session_id: sessionId,
          ...(data !== null && (event.type === "result" || event.type === "error") && data.session_id == null
            ? { data: { ...data, session_id: sessionId } }
            : {}),
        });
      }
    };

    const child = execa(this.bin, this.args, {
      cwd: task.cwd,
      env: { ...process.env, ...this.env },
      detached: true,
      reject: false,
      stdin: toAgent.readable,
      stdout: fromAgent.writable,
      stderr: "pipe",
    });
    const proc = trackProcess(child);

    const app = client({ name: CLIENT_INFO.name });
    app.onNotification("session/update", ({ params }) => {
      if (activeSessionId !== undefined && params.sessionId !== activeSessionId) return;
      if (launch_failure !== undefined) return;
      if (launch_state !== undefined) {
        try {
          if (params.update.sessionUpdate === "config_option_update") launch_state.replace_options(params.update.configOptions);
          if (params.update.sessionUpdate === "current_mode_update") launch_state.update_mode(params.update.currentModeId);
        } catch {
          launch_failure = new AcpLaunchConfigurationError("ACP session 配置违反显式启动选择，停止执行");
          shutdown(launch_failure.message, "configuration");
          return;
        }
      }
      for (const event of mapSessionUpdate(params.update)) {
        if (event.type === "text") {
          const data = event.data as { text?: unknown };
          if (params.update.sessionUpdate === "agent_message_chunk" && typeof data.text === "string") {
            agentText += data.text;
          }
        }
        push([event]);
      }
    });
    app.onRequest("session/request_permission", ({ params }) => {
      if (launch_failure !== undefined || shutdown_promise !== undefined) return { outcome: { outcome: "cancelled" as const } };
      if (inspect_only) {
        push([errorEvent("ACP 能力查询不允许工具权限请求", "permission")]);
        return { outcome: { outcome: "cancelled" as const } };
      }
      return this.answerPermission(params, { readonly, push, cwd: task.cwd,
        can_approve: () => launch_failure === undefined && shutdown_promise === undefined && !task.signal?.aborted });
    });

    const connection = app.connect(ndJsonStream(toAgent.writable, fromAgent.readable));
    const ctx: ClientContext = connection.agent;

    let sigkillTimer: NodeJS.Timeout | undefined;
    let shutdown_promise: Promise<void> | undefined;
    /** 收束序列（超时与外部取消共用）：error 落流 → 先 session/cancel 打完招呼 → 杀进程树 → 关流 */
    const shutdown = (reason: string, kind: "timeout" | "agent" | "configuration"): void => {
      if (shutdown_promise !== undefined) return;
      push([
        errorEvent(reason, kind, {
          session_id: activeSessionId ?? null,
        }),
      ]);
      shutdown_promise = (async () => {
        // 先 session/cancel 把话说完再杀（有上限，不能因为写不出去反而卡住）
        if (activeSessionId !== undefined) {
          await withTimeout(
            ctx.notify("session/cancel", { sessionId: activeSessionId }).catch(() => undefined),
            CANCEL_FLUSH_MS,
          );
          await delay(CANCEL_SETTLE_MS);
        }
        killProcessTree(proc, "SIGTERM");
        sigkillTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), this.killGraceMs);
        // 关流放在招呼之后：给 cancel 通知留出写通道，同时唤醒挂起的消费方
        queue.close();
      })();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      shutdown(`acp task timed out after ${timeoutMs}ms`, "timeout");
    }, timeoutMs);

    // ADR-0025：外部取消（run 取消）→ 立即收束（同超时路径，不等 wall-clock 超时）
    const onAbort = (): void => {
      shutdown("task aborted by caller", "agent");
    };
    if (task.signal !== undefined) {
      if (task.signal.aborted) onAbort();
      else task.signal.addEventListener("abort", onAbort, { once: true });
    }

    const stderrTail: string[] = [];
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

    const pump = async (): Promise<void> => {
      try {
        const initialized = await ctx.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { session: { configOptions: { boolean: {} } } },
          clientInfo: CLIENT_INFO,
        });
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          push([
            errorEvent(
              `agent negotiated unsupported Agent Client Protocol version ${initialized.protocolVersion} (client: ${PROTOCOL_VERSION})`,
              "protocol",
            ),
          ]);
          return;
        }

        let sessionId: string;
        let state: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null };
        if (resumeSessionId !== undefined) {
          if (resumeSessionId.length === 0 || initialized.agentCapabilities?.loadSession !== true) throw new Error("ACP 未协商支持原生 session resume");
          state = await ctx.request("session/load", {
            sessionId: resumeSessionId,
            cwd: task.cwd,
            mcpServers: [],
          });
          sessionId = resumeSessionId;
        } else {
          const created = await ctx.request("session/new", { cwd: task.cwd, mcpServers: [] });
          sessionId = created.sessionId;
          state = created;
        }
        activeSessionId = sessionId;
        this.onSession?.(sessionId);
        assert_running();
        launch_state = new AcpLaunchState(this.launch, readonly);
        launch_state.initialize(state);
        await this.configure_session(ctx, sessionId, launch_state, assert_running);
        assert_running();
        launch_state.seal();
        const configured = launch_state.configuration();
        if (inspect_only) {
          const modes = (state.modes?.availableModes ?? []).filter(mode => mode.id.length <= 200).map(mode => mode.id).slice(0, 128);
          const options = configured.filter(option => option.id.length <= 200).slice(0, 128).map(option => {
            const category = option.category == null ? null : option.category.slice(0, 200);
            const public_values = option.type === "select" && (["model", "thought_level", "mode"].includes(category ?? "") || Object.values(this.launch.option_ids ?? {}).includes(option.id));
            if (!public_values || option.type !== "select") return { id: option.id, type: option.type, category };
            const all = option.options.flatMap(entry => "group" in entry ? entry.options.map(item => item.value) : [entry.value]);
            const values = all.filter(value => value.length <= 200).slice(0, 128);
            return { id: option.id, type: option.type, category, values, omitted_values: all.length - values.length };
          });
          push([resultEvent(null, sessionId, { evidence: "acp_handshake", protocol_version: initialized.protocolVersion,
            native_resume: initialized.agentCapabilities?.loadSession === true,
            modes, omitted_modes: (state.modes?.availableModes?.length ?? 0) - modes.length,
            config_options: options, omitted_options: configured.length - options.length,
          } satisfies AcpCapabilityObservation)]);
          return;
        }

        const response = await ctx.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: task.prompt }],
        });
        assert_running();
        launch_state.assert_ready();

        push([
          resultEvent(agentText.length > 0 ? agentText : null, sessionId, {
            stop_reason: response.stopReason,
            usage: response.usage ?? null,
            raw: response,
          }, mapAcpUsage(response.usage)),
        ]);
      } catch (error) {
        if (!timedOut && shutdown_promise === undefined) {
          const message = error instanceof Error ? error.message : String(error);
          push([
            errorEvent(message, error instanceof AcpLaunchConfigurationError ? "configuration" : error instanceof RequestError ? "agent" : "protocol", {
              session_id: activeSessionId ?? null,
            }),
          ]);
        }
      } finally {
        clearTimeout(timeoutTimer);
        task.signal?.removeEventListener("abort", onAbort);
        await shutdown_promise;
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        // 每任务 subprocess：一次性用完即弃（ADR-0011），连接本地关闭 + 杀进程树
        try {
          connection.close();
        } catch {
          // 已关闭
        }
        await terminateProcessTree(proc, this.killGraceMs);
        queue.close();
      }
    };

    void pump();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // 消费方提前 break：清场，避免进程泄漏
      queue.close();
      clearTimeout(timeoutTimer);
      task.signal?.removeEventListener("abort", onAbort);
      // abort 后提前 return 也须等取消通知的有界发送，不能抢先杀进程。
      await shutdown_promise;
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      await terminateProcessTree(proc, this.killGraceMs);
    }
  }

  private async configure_session(ctx: ClientContext, session_id: string, state: AcpLaunchState, assert_running: () => void): Promise<void> {
    if (state.legacy_mode !== undefined) {
      state.assert_legacy_mode();
      const version = state.mode_version();
      try { await ctx.request("session/set_mode", { sessionId: session_id, modeId: state.legacy_mode }); }
      catch { assert_running(); throw new AcpLaunchConfigurationError("ACP 拒绝请求的 session mode"); }
      assert_running(); state.acknowledge_legacy_mode(version);
    }
    for (const [id, value] of state.entries()) {
      assert_running(); state.assert_supported(id, value);
      let response: unknown;
      try { response = await ctx.request("session/set_config_option", { sessionId: session_id, configId: id,
        ...(typeof value === "boolean" ? { type: "boolean" } : {}), value }); }
      catch { assert_running(); throw new AcpLaunchConfigurationError("ACP 拒绝请求的启动配置"); }
      assert_running();
      const parsed = AcpConfigResponseSchema.safeParse(response);
      if (!parsed.success) throw new AcpLaunchConfigurationError("ACP 配置回执结构不可验证");
      state.replace_options(parsed.data.configOptions);
      state.assert_selected(id, value);
    }
  }

  private async answerPermission(
    request: RequestPermissionRequest,
    state: { readonly: boolean; push: (events: AgentEvent[]) => void; cwd: string; can_approve: () => boolean },
  ): Promise<RequestPermissionResponse> {
    const title = request.toolCall.title ?? request.toolCall.toolCallId;
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

    const decision = await withTimeout(
      (async (): Promise<PermissionDecision | { failed: string }> => {
        try {
          return this.decidePermission !== undefined
            ? await this.decidePermission(request, { readonly: state.readonly })
            : this.permission_policy !== undefined && !state.readonly
              ? await decideAcpWorkspacePermission(request, this.permission_policy, state.cwd)
              : defaultPermissionDecision(request, state.readonly);
        } catch (error) {
          return { failed: error instanceof Error ? error.message : String(error) };
        }
      })(),
      this.permissionTimeoutMs,
    );
    if (!state.can_approve()) return cancelled;

    if (decision === TIMED_OUT) {
      state.push([
        errorEvent(
          this.permission_policy === undefined ? `permission request timed out after ${this.permissionTimeoutMs}ms; answered with cancelled: ${title}` : "ACP 范围权限校验超时，已取消请求",
          "permission",
          { raw: request },
        ),
      ]);
      return cancelled;
    }

    if ("failed" in decision) {
      state.push([
        errorEvent(this.permission_policy === undefined ? `permission decision failed (${decision.failed}); answered with cancelled: ${title}` : "ACP 范围权限校验失败，已取消请求", "permission", {
          raw: request,
        }),
      ]);
      return cancelled;
    }

    if ("optionId" in decision) {
      const option = request.options.find((candidate) => candidate.optionId === decision.optionId);
      if (option === undefined) {
        state.push([
          errorEvent(
            `permission option "${decision.optionId}" was not offered by the agent; answered with cancelled: ${title}`,
            "permission",
            { raw: request },
          ),
        ]);
        return cancelled;
      }
      const denied = option.kind === "reject_once" || option.kind === "reject_always";
      state.push([
        this.permission_policy === undefined ? textEvent(`[permission ${denied ? "denied" : "granted"}: ${option.name}] ${title}`, request)
          : textEvent(denied ? "ACP 权限请求已拒绝" : "ACP 文件操作已按声明范围一次授权", request, "metadata"),
      ]);
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }

    if (state.readonly) {
      state.push([this.permission_policy === undefined ? textEvent(`[permission denied: readonly] ${title}`, request) : textEvent("ACP 只读任务权限请求已拒绝", request, "metadata")]);
    } else {
      state.push([
        errorEvent(
          this.permission_policy === undefined ? `permission request requires human approval (M2 未接人工审批); answered with cancelled: ${title}`
            : "ACP 权限请求超出声明范围或无法验证，已取消；需要调整授权后再执行",
          "permission",
          { raw: request },
        ),
      ]);
    }
    return cancelled;
  }
}
