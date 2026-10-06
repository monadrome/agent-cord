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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import type { ErrorEventData, ResultEventData, TextEventData } from "../driver/headless.js";
import type { WorkflowNode } from "../workflow/executor.js";
import { buildContextPack } from "./context-pack.js";
import { readSnapshot } from "./snapshot.js";

const ADAPTER = "coordinator";
const PROMPT_EXCERPT_CHARS = 4_096;
const DEFAULT_MAX_RESULT_CHARS = 32_768;

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
  const filePath = join(session.dir, node.artifact);
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
    await writeFile(filePath, header + text.trim() + "\n", "utf8");
    return { artifact_written: true, written_by: "coordinator" };
  }
  return { artifact_written: false, written_by: "none" };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（截断，完整原文 ${text.length} 字符）`;
}

export function createNodeRunner(def: WorkflowDef, options: CoordinatorOptions): NodeRunner {
  const workflowId = def.metadata.id;

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
      const startedAt = Date.now();
      const agentName = node.run?.agent ?? "";
      const base = { workflow_id: ctx.workflow_id, node_id: ctx.node_id };

      const complete = async (
        status: NodeRunStatus,
        fields: Record<string, unknown>,
      ): Promise<{ status: NodeRunStatus }> => {
        await append(session, "agent.task.completed", {
          ...base,
          driver: agentName,
          status,
          duration_ms: Date.now() - startedAt,
          ...fields,
        }, node.id);
        return { status };
      };

      // 1. 最新快照 + 上下文包（worker 永远不看事件流）
      const snapshot = await readSnapshot(session);
      const prompt = buildContextPack(def, node, snapshot, {
        ...(options.maxPackChars !== undefined ? { maxPackChars: options.maxPackChars } : {}),
      });

      // 2. 驱动解析（失败也留 started + completed 痕迹，可审计）
      let driver: AgentDriver;
      try {
        driver = options.resolveDriver(agentName);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await append(session, "agent.task.started", {
          ...base,
          driver: agentName,
          prompt_excerpt: truncate(prompt, PROMPT_EXCERPT_CHARS),
        }, node.id);
        return complete("failed", { error: `驱动解析失败：${reason}`, text: "" });
      }

      await append(session, "agent.task.started", {
        ...base,
        driver: driver.name,
        prompt_excerpt: truncate(prompt, PROMPT_EXCERPT_CHARS),
      }, node.id);

      // 3. 派发 worker：聚合流式文本，result 事件优先；中间事件不入事件流
      let chunks = "";
      let resultText: string | null = null;
      let agentSessionId: string | null = null;
      let failure: { status: NodeRunStatus; message: string } | null = null;
      try {
        const task = {
          prompt,
          cwd: options.workspaceRoot,
          readonly: node.run?.readonly === true,
          ...(node.run?.timeout_ms !== undefined ? { timeout_ms: node.run.timeout_ms } : {}),
        };
        for await (const event of driver.run(task)) {
          if (event.type === "text") {
            chunks += (event.data as TextEventData).text;
          } else if (event.type === "result") {
            const data = event.data as ResultEventData;
            resultText = data.text;
            agentSessionId = data.session_id ?? agentSessionId;
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
      } catch (error) {
        failure = { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }

      const text = resultText ?? chunks;
      if (failure !== null) {
        return complete(failure.status, {
          error: failure.message,
          text: truncate(text, options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS),
          agent_session_id: agentSessionId,
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
      });
    },
  };
}
