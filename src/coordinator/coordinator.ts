/**
 * 协调 session agent（ADR-0023）：NodeRunner 的生产实现。
 *
 * 职责（协调，不执行具体开发）：
 * 1. 每节点执行前重建最新需求快照（ADR-0003：只持最新快照，历史留事件流）；
 * 2. 构建两层上下文包（高信号层 + 定位符层）派发给 worker agent；
 * 3. 经 AgentDriver 调度（claude / codex / kimi / agents.yaml 注册别名），事件落盘；
 * 4. artifact 写回校验：agent 自写优先，非空文本回退为 coordinator 代写 draft。
 *
 * 纪律：实现不抛错——一切失败归约为 agent.task.completed{status} 事件，由执行器决定停在节点。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ulid } from "ulid";
import type {
  AgentDriver,
  NodeRunContext,
  NodeRunner,
  NodeRunStatus,
  SessionHandle,
} from "../core/ports.js";
import type { EventDraft, WorkflowDef } from "../core/schema.js";
import { isPlaceholderDoc } from "../core/session.js";
import { delay } from "../driver/headless.js";
import type { ErrorEventData, ResultEventData, TextEventData } from "../driver/headless.js";
import type { WorkflowNode } from "../workflow/executor.js";
import { buildContextPack } from "./context-pack.js";
import { readSnapshot, resolveSessionFile } from "./snapshot.js";

const ADAPTER = "coordinator";
const PROMPT_EXCERPT_CHARS = 4_096;
const DEFAULT_MAX_RESULT_CHARS = 32_768;
const ABORTED = Symbol("run-aborted");

/** 迭代器 next() 与取消信号竞速：worker 静默期（无事件）取消也要即时生效 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return Promise.race([
    promise,
    new Promise<typeof ABORTED>((resolve) => {
      signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
    }),
  ]);
}

export interface CoordinatorOptions {
  /** 驱动解析（registry 语法）；解析失败归约为 failed，不抛错 */
  resolveDriver: (name: string) => AgentDriver;
  /** worker 的工作目录（工作区根；agent 在此读写 cord/<req-id>/ 快照） */
  workspaceRoot: string;
  /** 上下文包总字符上限 */
  maxPackChars?: number;
  /** agent.task.completed.text 上限（默认 32KB，防事件流膨胀） */
  maxResultChars?: number;
}

interface ArtifactSettle {
  artifact_written: boolean;
  written_by: "agent" | "coordinator" | "none";
}

/** artifact 写回双通道（ADR-0023 决策 4）：agent 自写优先，文本回退 coordinator 代写 draft */
async function settleArtifact(
  node: WorkflowNode,
  session: SessionHandle,
  text: string,
  driverName: string,
): Promise<ArtifactSettle> {
  if (node.artifact === undefined || node.run?.readonly === true) {
    return { artifact_written: false, written_by: "none" };
  }
  const filePath = resolveSessionFile(session.dir, node.artifact);
  if (filePath === null) {
    throw new Error(`artifact 路径必须位于 session 目录内：${JSON.stringify(node.artifact)}`);
  }
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing.trim().length > 0 && !isPlaceholderDoc(existing)) {
      return { artifact_written: true, written_by: "agent" };
    }
  } catch {
    // 文件不存在 → 走代写回退
  }
  if (text.trim().length > 0) {
    const header = `<!-- 由协调 agent 代写（${driverName}，${new Date().toISOString()}）；经后续门禁与人审生效 -->\n\n`;
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, header + text.trim() + "\n", "utf8");
    await rename(temporary, filePath);
    return { artifact_written: true, written_by: "coordinator" };
  }
  return { artifact_written: false, written_by: "none" };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（截断，完整原文 ${text.length} 字符）`;
}

export function createNodeRunner(def: WorkflowDef, options: CoordinatorOptions): NodeRunner {
  const append = async (
    session: SessionHandle,
    type: "agent.task.started" | "agent.task.completed",
    payload: Record<string, unknown>,
    nodeId: string,
  ): Promise<void> => {
    const draft: EventDraft = {
      event_id: ulid(),
      session_id: session.req_id,
      type,
      schema_version: "1",
      actor: { kind: "agent", id: ADAPTER },
      correlation_id: nodeId,
      payload,
      source: { adapter: ADAPTER },
    };
    await session.events.append(draft);
  };

  return {
    async runNode(node: WorkflowNode, session: SessionHandle, ctx: NodeRunContext) {
      const maxAttempts = node.run?.retry?.max_attempts ?? 1;
      const backoffMs = node.run?.retry?.backoff_ms ?? 0;
      let lastStatus: NodeRunStatus = "failed";
      let lastError: string | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // ADR-0025：取消信号在尝试边界生效（进行中的派发在 runAttempt 内即时收束）
        if (ctx.signal?.aborted === true) return { status: "cancelled" };
        const outcome = await runAttempt(node, session, ctx, attempt, maxAttempts, lastError);
        if (outcome.status === "ok" || outcome.status === "cancelled") return outcome;
        lastStatus = outcome.status;
        lastError = outcome.error;
        if (attempt < maxAttempts && backoffMs > 0) {
          // 线性退避：第 n 次失败后等 backoff × n（取消即时打断）
          const waited = await raceAbort(delay(backoffMs * attempt), ctx.signal);
          if (waited === ABORTED) return { status: "cancelled" };
        }
      }
      return { status: lastStatus };
    },
  };

  /**
   * 单次尝试：最新快照 + 上下文包（重试时带上次失败摘要，让 worker 避开同一失败模式）→
   * 驱动解析 → 派发 → artifact 写回校验。一切失败归约为 completed{status} 事件。
   */
  async function runAttempt(
    node: WorkflowNode,
    session: SessionHandle,
    ctx: NodeRunContext,
    attempt: number,
    maxAttempts: number,
    previousError: string | null,
  ): Promise<{ status: NodeRunStatus; error: string | null }> {
    const startedAt = Date.now();
    const agentName = node.run?.agent ?? "";
    const base = {
      workflow_id: ctx.workflow_id,
      node_id: ctx.node_id,
      attempt,
      ...(maxAttempts > 1 ? { max_attempts: maxAttempts } : {}),
    };

    // 1. 最新快照 + 上下文包（worker 永远不看事件流）
    const snapshot = await readSnapshot(session, {
      files: def.spec.nodes.flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
    });
    let prompt = buildContextPack(def, node, snapshot, {
      ...(options.maxPackChars !== undefined ? { maxPackChars: options.maxPackChars } : {}),
    });
    if (previousError !== null) {
      prompt += `\n\n## 上次尝试失败（第 ${attempt - 1} 次）\n${truncate(previousError, 2_000)}\n请避开同一失败模式。`;
    }

    const snapshotFields = {
      snapshot_id: snapshot.snapshot_id,
      snapshot_event_seq: snapshot.event_seq,
      snapshot_event_chain_hash: snapshot.event_chain_hash,
    };
    const complete = async (
      status: NodeRunStatus,
      fields: Record<string, unknown>,
    ): Promise<{ status: NodeRunStatus; error: string | null }> => {
      await append(session, "agent.task.completed", {
        ...base,
        ...snapshotFields,
        driver: agentName,
        status,
        duration_ms: Date.now() - startedAt,
        ...fields,
      }, node.id);
      return {
        status,
        error: typeof fields["error"] === "string" ? fields["error"] : null,
      };
    };

    // 2. 驱动解析（定义性错误，重试不会自愈 → 直接 failed 不消耗尝试次数语义外的机会）
    if (
      node.artifact !== undefined &&
      node.run?.readonly !== true &&
      resolveSessionFile(session.dir, node.artifact) === null
    ) {
      await append(session, "agent.task.started", {
        ...base,
        ...snapshotFields,
        driver: agentName,
        prompt_excerpt: truncate(prompt, PROMPT_EXCERPT_CHARS),
      }, node.id);
      return complete("failed", {
        error: `artifact 路径必须位于 session 目录内：${JSON.stringify(node.artifact)}`,
        text: "",
      });
    }
    let driver: AgentDriver;
    try {
      driver = options.resolveDriver(agentName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await append(session, "agent.task.started", {
        ...base,
        ...snapshotFields,
        driver: agentName,
        prompt_excerpt: truncate(prompt, PROMPT_EXCERPT_CHARS),
      }, node.id);
      return complete("failed", { error: `驱动解析失败：${reason}`, text: "" });
    }

    await append(session, "agent.task.started", {
      ...base,
      ...snapshotFields,
      driver: driver.name,
      prompt_excerpt: truncate(prompt, PROMPT_EXCERPT_CHARS),
    }, node.id);

    // 3. 派发 worker：聚合流式文本，result 事件优先；中间事件不入事件流
    let chunks = "";
    let resultText: string | null = null;
    let agentSessionId: string | null = null;
    let usage: ResultEventData["usage"] = null;
    let cancelled = false;
    let failure: { status: NodeRunStatus; message: string } | null = null;
    try {
      const task = {
        prompt,
        cwd: options.workspaceRoot,
        readonly: node.run?.readonly === true,
        ...(node.run?.timeout_ms !== undefined ? { timeout_ms: node.run.timeout_ms } : {}),
        // ADR-0025：取消信号直达 driver（静默期也能即时杀进程树），不依赖事件到达
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };
      // 手动迭代 + 取消竞速：worker 静默期（无事件到达）取消也要即时收束；
      // 收束经 iterator.return() 触发 driver 清理（杀进程树）
      const iterator = driver.run(task)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await raceAbort(iterator.next(), ctx.signal);
          if (next === ABORTED) {
            cancelled = true;
            break;
          }
          if (next.done) break;
          const event = next.value;
          if (event.type === "text") {
            chunks += (event.data as TextEventData).text;
          } else if (event.type === "result") {
            const data = event.data as ResultEventData;
            resultText = data.text;
            agentSessionId = data.session_id ?? agentSessionId;
            usage = data.usage ?? usage;
          } else if (event.type === "error") {
            const data = event.data as ErrorEventData;
            agentSessionId = data.session_id ?? agentSessionId;
            // 取最后一个 error 为准（超时后可能还有 agent 错误余波）
            failure = {
              status: data.kind === "timeout" ? "timeout" : "failed",
              message: data.message,
            };
          }
        }
      } finally {
        await iterator.return?.();
      }
    } catch (error) {
      failure = { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }

    const text = resultText ?? chunks;
    if (cancelled) {
      return complete("cancelled", {
        error: "run 已取消（workflow.run.cancelled）",
        text: truncate(text, options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS),
        agent_session_id: agentSessionId,
        usage: usage ?? null,
      });
    }
    if (failure !== null) {
      return complete(failure.status, {
        error: failure.message,
        text: truncate(text, options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS),
        agent_session_id: agentSessionId,
        usage: usage ?? null,
      });
    }

    // 4. artifact 写回校验（双通道）
    const settle = await settleArtifact(node, session, text, driver.name);
    return complete("ok", {
      text: truncate(text, options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS),
      artifact: node.artifact ?? null,
      artifact_written: settle.artifact_written,
      written_by: settle.written_by,
      agent_session_id: agentSessionId,
      usage: usage ?? null,
    });
  }
}
