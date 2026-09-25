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
} from "@agentclientprotocol/sdk";
import { execa } from "execa";
import type { AgentDriver, AgentEvent, AgentTask } from "../core/ports.js";
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
    case "agent_thought_chunk":
    case "user_message_chunk":
    case "compaction_summary_chunk":
      return [textEvent(contentToText(update.content), update)];
    case "tool_call":
    case "tool_call_update":
      return [toolUseEvent(update.title ?? update.kind ?? null, update.rawInput ?? null, update)];
    default:
      return [textEvent("", update)];
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface AcpDriverOptions {
  /** agent 二进制（如 kimi / opencode / claude-agent-acp） */
  bin: string;
  /** 子命令，默认 ["acp"] */
  args?: string[];
  /** 暴露给 registry 的驱动名，默认 `acp:<bin>` */
  name?: string;
  env?: Record<string, string>;
  /** permission request 的防御性超时 */
  permission_timeout_ms?: number;
  /** SIGTERM → SIGKILL 之间的等待 */
  kill_grace_ms?: number;
  /** 自定义审批决策（M3 人工桥接挂载点）；缺省走 M2 规则：只读拒绝，否则取消并上抛 error */
  decidePermission?: PermissionDecider;
  /** 会话 id 回执（宿主也可从 `AgentEvent.session_id` / result 事件的 data 里取） */
  onSession?: (sessionId: string) => void;
}

export class AcpDriver implements AgentDriver {
  readonly name: string;
  /** agent 二进制（doctor / registry 观测用） */
  readonly bin: string;
  readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly permissionTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly decidePermission: PermissionDecider | undefined;
  private readonly onSession: ((sessionId: string) => void) | undefined;

  constructor(options: AcpDriverOptions) {
    this.bin = options.bin;
    this.args = options.args ?? ["acp"];
    this.name = options.name ?? `acp:${options.bin}`;
    this.env = options.env ?? {};
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

  private async *execute(task: AgentTask, resumeSessionId: string | undefined): AsyncIterable<AgentEvent> {
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
      for (const event of mapSessionUpdate(params.update)) {
        if (event.type === "text") {
          const data = event.data as { text?: unknown };
          if (params.update.sessionUpdate === "agent_message_chunk" && typeof data.text === "string") {
            agentText += data.text;
          }
        }
        queue.push(event);
      }
    });
    app.onRequest("session/request_permission", ({ params }) =>
      this.answerPermission(params, { readonly, queue }),
    );

    const connection = app.connect(ndJsonStream(toAgent.writable, fromAgent.readable));
    const ctx: ClientContext = connection.agent;

    let sigkillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      queue.push(
        errorEvent(`acp task timed out after ${timeoutMs}ms`, "timeout", {
          session_id: activeSessionId ?? null,
        }),
      );
      void (async () => {
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
      })();
    }, timeoutMs);

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
          clientCapabilities: {},
          clientInfo: CLIENT_INFO,
        });
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          queue.push(
            errorEvent(
              `agent negotiated unsupported Agent Client Protocol version ${initialized.protocolVersion} (client: ${PROTOCOL_VERSION})`,
              "protocol",
            ),
          );
          return;
        }

        let sessionId: string;
        if (resumeSessionId !== undefined) {
          await ctx.request("session/load", {
            sessionId: resumeSessionId,
            cwd: task.cwd,
            mcpServers: [],
          });
          sessionId = resumeSessionId;
        } else {
          const created = await ctx.request("session/new", { cwd: task.cwd, mcpServers: [] });
          sessionId = created.sessionId;
        }
        activeSessionId = sessionId;
        this.onSession?.(sessionId);

        const response = await ctx.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: task.prompt }],
        });

        queue.push(
          resultEvent(agentText.length > 0 ? agentText : null, sessionId, {
            stop_reason: response.stopReason,
            usage: response.usage ?? null,
            raw: response,
          }),
        );
      } catch (error) {
        if (!timedOut) {
          const message = error instanceof Error ? error.message : String(error);
          queue.push(
            errorEvent(message, error instanceof RequestError ? "agent" : "protocol", {
              session_id: activeSessionId ?? null,
            }),
          );
        }
      } finally {
        clearTimeout(timeoutTimer);
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
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      await terminateProcessTree(proc, this.killGraceMs);
    }
  }

  private async answerPermission(
    request: RequestPermissionRequest,
    state: { readonly: boolean; queue: AsyncQueue<AgentEvent> },
  ): Promise<RequestPermissionResponse> {
    const title = request.toolCall.title ?? request.toolCall.toolCallId;
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

    const decision = await withTimeout(
      (async (): Promise<PermissionDecision | { failed: string }> => {
        try {
          return this.decidePermission !== undefined
            ? await this.decidePermission(request, { readonly: state.readonly })
            : defaultPermissionDecision(request, state.readonly);
        } catch (error) {
          return { failed: error instanceof Error ? error.message : String(error) };
        }
      })(),
      this.permissionTimeoutMs,
    );

    if (decision === TIMED_OUT) {
      state.queue.push(
        errorEvent(
          `permission request timed out after ${this.permissionTimeoutMs}ms; answered with cancelled: ${title}`,
          "permission",
          { raw: request },
        ),
      );
      return cancelled;
    }

    if ("failed" in decision) {
      state.queue.push(
        errorEvent(`permission decision failed (${decision.failed}); answered with cancelled: ${title}`, "permission", {
          raw: request,
        }),
      );
      return cancelled;
    }

    if ("optionId" in decision) {
      const option = request.options.find((candidate) => candidate.optionId === decision.optionId);
      if (option === undefined) {
        state.queue.push(
          errorEvent(
            `permission option "${decision.optionId}" was not offered by the agent; answered with cancelled: ${title}`,
            "permission",
            { raw: request },
          ),
        );
        return cancelled;
      }
      const denied = option.kind === "reject_once" || option.kind === "reject_always";
      state.queue.push(
        textEvent(`[permission ${denied ? "denied" : "granted"}: ${option.name}] ${title}`, request),
      );
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }

    if (state.readonly) {
      state.queue.push(textEvent(`[permission denied: readonly] ${title}`, request));
    } else {
      state.queue.push(
        errorEvent(
          `permission request requires human approval (M2 未接人工审批); answered with cancelled: ${title}`,
          "permission",
          { raw: request },
        ),
      );
    }
    return cancelled;
  }
}
