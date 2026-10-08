/**
 * 薄执行器（ADR-0018 决策 3）：读图 → 拓扑推进 → 每步事件落盘 → 恢复时按事件流扫点。
 *
 * 事件 payload 约定（权威 schema 见 core/schema.ts，全部带 `workflow_id` 便于
 * 同 session 内多流程共存）：
 * - `workflow.node.entered`：{ workflow_id, node_id, artifact, resumed }
 * - `workflow.node.exited`： { workflow_id, node_id, artifact, gates: GateSummary[] }
 * - `gate.waiting`：         { workflow_id, node_id, gate_id, phase, kind, question, options, reason, result, timed_out }
 * - `gate.resolved`：        { workflow_id, node_id, gate_id, phase, result, action, reason, anchors, confidence,
 *                              checks, human_confirmed, answer?, write_back }
 * `correlation_id` = 节点 id（gate 事件与所属节点同链）。
 * checker 上下文由执行器填 `session_dir` + `session`（ctx.session 是读账本的推荐通道）。
 *
 * 幂等要求（ADR-0018 注意点 4）：恢复单位是**节点**——有 `node.exited` 即跳过，因此
 * 未退出节点的 gate 会被重新求值、人工选择题会被重新发起；故节点的副作用必须幂等：
 * check 必须只读可重放（不写文件、不改外部状态），节点产物写入必须可重放。
 * 执行器自身只经 `session.events.append` 改状态，不写任何文件（ADR-0020 单写路径）。
 */
import { alg, Graph } from "@dagrejs/graphlib";
import { ulid } from "ulid";
import {
  AnchorSchema,
  GateResultSchema,
  type Actor,
  type Anchor,
  type EventDraft,
  type EventEnvelope,
  type EventType,
  type GateAction,
  type GateDef,
  type GateResult,
  type WorkflowDef,
} from "../core/schema.js";
import type {
  CheckerContext,
  CheckerRegistry,
  HumanGate,
  HumanGateAnswer,
  HumanGateContext,
  NodeRunner,
  SessionHandle,
  WorkflowExecutor,
} from "../core/ports.js";
import { createBuiltinRegistry } from "./checkers.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { matchesWorkflowScope } from "./scope.js";

export type WorkflowNode = WorkflowDef["spec"]["nodes"][number];

export interface GateSummary {
  gate_id: string;
  result: GateResult["result"];
  action: GateAction;
  reason: string;
}

export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionError";
  }
}

export class WorkflowCycleError extends WorkflowDefinitionError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCycleError";
  }
}

export interface ExecutorOptions {
  /** ADR-0034：宿主固定的执行版本；缺省为无版本兼容模式。 */
  workflow_revision?: string;
  /** 当前 workflow run 身份；验证 checker 用于隔离同输入的不同 run。 */
  run_id?: string;
  /** 门禁等待人工时的选择题通道（M2: CLI；M3: 飞书） */
  humanGate: HumanGate;
  /** 固定注册表（跨 session 复用）；未提供时按 `registryFor` / 内置注册表构造 */
  registry?: CheckerRegistry;
  /** 按 session 构造注册表；默认 `createBuiltinRegistry()`（执行器把 session 放进 `ctx.session`，checker 无需被绑） */
  registryFor?: (session: SessionHandle) => CheckerRegistry;
  /** checker 上下文 payload（checker 的输入通道，如 anchors / vote_verdict / entry_id） */
  payload?: Record<string, unknown>;
  /** 按节点覆盖 payload；优先于 payload */
  payloadFor?: (node: WorkflowNode) => Record<string, unknown>;
  /**
   * 节点执行体（ADR-0023）：节点声明 run 时调用；未注入则跳过执行并在 node.exited 记 warn（fail-visible）。
   * 恢复扫点：通过 NodeRunner 校验输入指纹与产物后，才复用历史 ok（ADR-0030）。
   */
  nodeRunner?: NodeRunner;
  /** ADR-0030：宿主提供稳定的审批输入指纹（不含控制事件），server 使用需求快照 */
  gateInputHash?: (node: WorkflowNode, gate: GateDef, session: SessionHandle) => Promise<string>;
  /** run 取消信号（ADR-0025）：节点边界与人工挂起点检查；abort 后执行器止步（不落假判定） */
  signal?: AbortSignal;
  actor?: Actor;
}

const ADAPTER = "workflow-executor";
const DEFAULT_ACTOR: Actor = { kind: "system", id: ADAPTER };

export function createExecutor(options: ExecutorOptions): WorkflowExecutor {
  const actor = options.actor ?? DEFAULT_ACTOR;
  return {
    /**
     * 从头执行或扫点恢复。被 block / 等待人工 / 超时挂起时正常返回（状态已落盘，可从事件恢复），
     * 定义错误、存储失败与无法读取宿主审批输入时上抛，不伪造终态。
     *
     * 停在节点上的流程修好输入后再次 run 即可续跑：该节点被重新求值，故会看到重复的
     * `gate.resolved`——那是重试痕迹（同节点同类事件取最后一条即最新判定），不是新判定。
     */
    async run(def: WorkflowDef, session: SessionHandle): Promise<void> {
      const workflow_id = def.metadata.id;
      const workflow_revision = options.workflow_revision;
      if (workflow_revision !== undefined && !/^[0-9a-f]{64}$/.test(workflow_revision)) throw new WorkflowDefinitionError("workflow_revision 必须是 SHA-256 指纹");
      const scope = { workflow_id, workflow_revision };
      const registry =
        options.registry ?? options.registryFor?.(session) ?? createBuiltinRegistry();
      const nodes = new Map(def.spec.nodes.map((node) => [node.id, node]));
      const gatesByNode = indexGates(def);
      const order = topologicalOrder(def);
      const state = await scan(session, workflow_id, workflow_revision);

      for (const nodeId of order) {
        if (state.completed.has(nodeId)) continue;
        node_attempt: for (;;) {
          // ADR-0025：run 取消在节点边界生效（不中断已退出节点的事实，停止推进后续节点）
          if (options.signal?.aborted === true) return;
          const node = nodes.get(nodeId);
          if (!node) throw new WorkflowDefinitionError(`拓扑序中的节点缺少定义：${nodeId}`);

          const payload = options.payloadFor?.(node) ?? options.payload ?? {};
          const ctx: CheckerContext = {
            session_dir: session.dir,
            ...scope,
            ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
            anchors: extractAnchors(payload),
            payload,
            node_id: nodeId,
            session,
          };

          await appendEvent(
            session,
            actor,
            "workflow.node.entered",
            {
              ...scope,
              node_id: nodeId,
              artifact: node.artifact ?? null,
              resumed: state.entered.has(nodeId),
            },
            nodeId,
          );

          const summaries: GateSummary[] = [];
          const notes: string[] = [];
          const runGates = async (gates: GateDef[]): Promise<"continue" | "stop" | "restart"> => {
            for (const gate of gates) {
              if (options.signal?.aborted === true) return "stop";
              const outcome = await runGate({
                ...scope,
                node_id: nodeId,
                gate,
                session,
                registry,
                humanGate: options.humanGate,
                ctx,
                actor,
                pending: state.waiting.get(gateKey(nodeId, gate.id)),
                ...(options.gateInputHash !== undefined ? { inputHash: () => options.gateInputHash!(node, gate, session) } : {}),
                ...(gate.attach.when === "post" && options.nodeRunner?.isCompletionReusable !== undefined && state.agentDone.has(nodeId)
                  ? { checkpointCurrent: () => options.nodeRunner!.isCompletionReusable!(node, session, { ...scope, node_id: nodeId }, state.agentDone.get(nodeId)!) }
                  : {}),
                signal: options.signal,
              });
              if (outcome.summary) summaries.push(outcome.summary);
              if (outcome.restart_node) return "restart";
              if (outcome.stop) return "stop";
            }
            return "continue";
          };

          const nodeGates = gatesByNode.get(nodeId) ?? [];
          // pre gate → node.run → post gate（ADR-0014：pre = 节点前；ADR-0023：执行体在两段 gate 之间）
          if (await runGates(nodeGates.filter((gate) => gate.attach.when === "pre")) === "stop") return;

          if (node.run !== undefined) {
            if (options.nodeRunner === undefined) {
              notes.push("节点声明了 run 执行体但未注入 NodeRunner，执行被跳过（fail-visible）");
            } else {
              const completion = state.agentDone.get(nodeId);
              let reusable = false;
              if (completion !== undefined && options.nodeRunner.isCompletionReusable !== undefined) {
                try {
                  reusable = await options.nodeRunner.isCompletionReusable(node, session, { ...scope, node_id: nodeId }, completion) === true;
                } catch {
                  notes.push("无法验证历史任务输入，按最新快照重新执行");
                }
              }
              if (reusable) {
                notes.push("历史任务输入与产物仍有效，跳过重复执行");
              } else {
                for (const gate of nodeGates.filter((item) => item.attach.when === "post")) {
                  const pending = state.waiting.get(gateKey(nodeId, gate.id));
                  if (pending !== undefined) {
                    await invalidateWaiting(session, actor, { ...scope, node_id: nodeId, gate_id: gate.id, phase: "post" }, pending.waiting_event_id, "worker 输入或产物已变化，旧审批不能用于重跑后的产物");
                    state.waiting.delete(gateKey(nodeId, gate.id));
                  }
                }
                const outcome = await options.nodeRunner.runNode(node, session, {
                  ...scope,
                  node_id: nodeId,
                  ...(options.signal !== undefined ? { signal: options.signal } : {}),
                });
                // 失败/超时/取消：停在该节点，修复后按新输入重跑。
                if (outcome.status !== "ok") return;
                const latest = [...await session.events.readOrdered()].reverse().find((event) =>
                  event.type === "agent.task.completed" && matchesWorkflowScope(event.payload, scope) && asRecord(event.payload)?.["node_id"] === nodeId,
                );
                if (latest !== undefined) state.agentDone.set(nodeId, latest);
              }
            }
          }

          const post = await runGates(nodeGates.filter((gate) => gate.attach.when === "post"));
          if (post === "stop") return;
          if (post === "restart") {
            state.entered.add(nodeId);
            for (const [key, waiting] of state.waiting) if (waiting.node_id === nodeId) state.waiting.delete(key);
            continue node_attempt;
          }

          await appendEvent(
            session,
            actor,
            "workflow.node.exited",
            {
              ...scope,
              node_id: nodeId,
              artifact: node.artifact ?? null,
              gates: summaries,
              ...(notes.length > 0 ? { notes } : {}),
            },
            nodeId,
          );
          break;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 图：拓扑排序（graphlib）
// ---------------------------------------------------------------------------

/**
 * graphlib 的 .d.ts 用无扩展名相对导入，在本仓库 NodeNext 下解析失败（被 skipLibCheck 掩盖），
 * 导出符号退化为 any；这里按用到的 API 声明最小结构类型，运行时仍用 graphlib（ADR-0018 决策 3）。
 */
interface NodeGraph {
  setNode(name: string): unknown;
  setEdge(v: string, w: string): unknown;
  nodes(): string[];
  predecessors(v: string): string[] | undefined;
  successors(v: string): string[] | undefined;
}

const createGraph = Graph as unknown as new (options: { directed: boolean }) => NodeGraph;
const topsort = alg.topsort as unknown as (graph: NodeGraph) => string[];
const findCycles = alg.findCycles as unknown as (graph: NodeGraph) => string[][];

/** 拓扑序：环抛 WorkflowCycleError；同层节点按定义序稳定择先（图是低频人审资产，顺序要可预期）。 */
export function topologicalOrder(def: WorkflowDef): string[] {
  const graph = buildGraph(def);
  try {
    topsort(graph);
  } catch {
    throw new WorkflowCycleError(
      `workflow "${def.metadata.id}" 存在环，涉及节点：${describeCycles(graph)}`,
    );
  }
  return stableOrder(graph, def);
}

function buildGraph(def: WorkflowDef): NodeGraph {
  const graph = new createGraph({ directed: true });
  const known = new Set(def.spec.nodes.map((node) => node.id));
  for (const nodeId of known) graph.setNode(nodeId);
  for (const node of def.spec.nodes) {
    for (const dep of node.depends_on) {
      if (!known.has(dep)) {
        throw new WorkflowDefinitionError(`节点 "${node.id}" 依赖不存在的节点 "${dep}"`);
      }
      graph.setEdge(dep, node.id);
    }
  }
  return graph;
}

function stableOrder(graph: NodeGraph, def: WorkflowDef): string[] {
  const declaredIndex = new Map(def.spec.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map<string, number>();
  const remaining = new Set(graph.nodes());
  for (const nodeId of remaining) indegree.set(nodeId, graph.predecessors(nodeId)?.length ?? 0);

  const order: string[] = [];
  while (remaining.size > 0) {
    let picked: string | undefined;
    let pickedIndex = Number.POSITIVE_INFINITY;
    for (const nodeId of remaining) {
      if ((indegree.get(nodeId) ?? 0) !== 0) continue;
      const index = declaredIndex.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
      if (index < pickedIndex) {
        picked = nodeId;
        pickedIndex = index;
      }
    }
    if (picked === undefined) {
      throw new WorkflowCycleError(`workflow "${def.metadata.id}" 存在环：${describeCycles(graph)}`);
    }
    remaining.delete(picked);
    order.push(picked);
    for (const successor of graph.successors(picked) ?? []) {
      if (remaining.has(successor)) indegree.set(successor, (indegree.get(successor) ?? 1) - 1);
    }
  }
  return order;
}

function describeCycles(graph: NodeGraph): string {
  const cycles = findCycles(graph);
  if (cycles.length === 0) return "<unknown>";
  return cycles.map((cycle) => cycle.join(" → ")).join("；");
}

function indexGates(def: WorkflowDef): Map<string, GateDef[]> {
  const byNode = new Map<string, GateDef[]>();
  for (const node of def.spec.nodes) {
    const pre = node.gates.filter((gate) => gate.attach.when === "pre");
    const post = node.gates.filter((gate) => gate.attach.when === "post");
    byNode.set(node.id, [...pre, ...post]);
  }
  return byNode;
}

// ---------------------------------------------------------------------------
// 恢复扫点
// ---------------------------------------------------------------------------

interface WaitingGate {
  waiting_event_id: string;
  evaluation_hash?: string;
  node_id: string;
  gate_id: string;
  kind: "human_confirm" | "escalation";
  question: string;
  options: string[];
  reason: string;
  result?: "pass" | "warn";
}

interface ScannedState {
  /** 有 node.exited 的节点 */
  completed: Set<string>;
  entered: Set<string>;
  /** 有 gate.waiting 且尚未 gate.resolved 的 gate（key = node/gate） */
  waiting: Map<string, WaitingGate>;
  /** 最近有效 ok 的候选 checkpoint；恢复仍需 NodeRunner 验证当前输入与产物 */
  agentDone: Map<string, EventEnvelope>;
}

async function scan(session: SessionHandle, workflowId: string, workflow_revision?: string): Promise<ScannedState> {
  const completed = new Set<string>();
  const entered = new Set<string>();
  const waiting = new Map<string, WaitingGate>();
  const agentDone = new Map<string, EventEnvelope>();

  for (const event of await session.events.readOrdered()) {
    const payload = asRecord(event.payload);
    if (!payload || !matchesWorkflowScope(payload, { workflow_id: workflowId, workflow_revision })) continue;
    const nodeId = payload["node_id"];
    const gateId = payload["gate_id"];
    if (event.type === "workflow.run.cancelled") { waiting.clear(); continue; }
    if (event.type === "workflow.node.entered" && typeof nodeId === "string") {
      entered.add(nodeId);
      // resumed entered 保留 checkpoint，明确的新任务 started 才使旧任务失效。
      if (payload["resumed"] !== true) agentDone.delete(nodeId);
    } else if (event.type === "workflow.node.exited" && typeof nodeId === "string") {
      completed.add(nodeId);
    } else if (event.type === "agent.task.started" && typeof nodeId === "string") {
      agentDone.delete(nodeId);
    } else if (event.type === "agent.task.completed" && typeof nodeId === "string") {
      if (payload["status"] === "ok") agentDone.set(nodeId, event);
      else agentDone.delete(nodeId);
    } else if (
      event.type === "gate.waiting" &&
      typeof nodeId === "string" &&
      typeof gateId === "string"
    ) {
      waiting.set(gateKey(nodeId, gateId), toWaitingGate(nodeId, gateId, payload, event.event_id));
    } else if (event.type === "gate.invalidated" && typeof nodeId === "string" && typeof gateId === "string") {
      const key = gateKey(nodeId, gateId);
      if (waiting.get(key)?.waiting_event_id === payload["waiting_event_id"]) waiting.delete(key);
    } else if (
      event.type === "gate.resolved" &&
      typeof nodeId === "string" &&
      typeof gateId === "string"
    ) {
      waiting.delete(gateKey(nodeId, gateId));
    }
  }
  return { completed, entered, waiting, agentDone };
}

function toWaitingGate(
  nodeId: string,
  gateId: string,
  payload: Record<string, unknown>,
  event_id: string,
): WaitingGate {
  const rawOptions = Array.isArray(payload["options"]) ? payload["options"] : [];
  const options = rawOptions.filter((option): option is string => typeof option === "string");
  const result = payload["result"];
  return {
    waiting_event_id: event_id,
    ...(typeof payload["evaluation_hash"] === "string" ? { evaluation_hash: payload["evaluation_hash"] } : {}),
    node_id: nodeId,
    gate_id: gateId,
    kind: payload["kind"] === "human_confirm" ? "human_confirm" : "escalation",
    question:
      typeof payload["question"] === "string"
        ? payload["question"]
        : `门禁 ${gateId} 等待人工裁决（放行 / 终止）`,
    options: options.length >= 2 ? options : ["放行", "终止"],
    reason: typeof payload["reason"] === "string" ? payload["reason"] : "",
    result: result === "pass" || result === "warn" ? result : undefined,
  };
}

function gateKey(nodeId: string, gateId: string): string {
  return JSON.stringify([nodeId, gateId]);
}

// ---------------------------------------------------------------------------
// 单个 gate 的求值（三态 + 人工分支）
// ---------------------------------------------------------------------------

interface GateBase {
  workflow_id: string;
  workflow_revision?: string;
  node_id: string;
  gate_id: string;
  phase: "pre" | "post";
}

interface CheckOutcome {
  ref: string;
  result: GateResult;
}

interface GateRun {
  workflow_id: string;
  workflow_revision?: string;
  node_id: string;
  gate: GateDef;
  session: SessionHandle;
  registry: CheckerRegistry;
  humanGate: HumanGate;
  ctx: CheckerContext;
  actor: Actor;
  pending?: WaitingGate | undefined;
  inputHash?: () => Promise<string>;
  checkpointCurrent?: () => Promise<boolean>;
  /** run 取消信号（ADR-0025）：人工挂起点可中断 */
  signal?: AbortSignal | undefined;
}

interface GateOutcome {
  stop: boolean;
  summary?: GateSummary;
  recheck?: boolean;
  restart_node?: boolean;
}

async function runGate(run: GateRun): Promise<GateOutcome> {
  let current = run;
  for (;;) {
    if (current.signal?.aborted === true) return { stop: true };
    if (current.checkpointCurrent !== undefined && !(await current.checkpointCurrent())) {
      const pending = current.pending;
      if (pending !== undefined) await invalidateWaiting(current.session, current.actor, {
        workflow_id: current.workflow_id, workflow_revision: current.workflow_revision, node_id: current.node_id, gate_id: current.gate.id, phase: current.gate.attach.when,
      }, pending.waiting_event_id, "worker 输入或产物已变化，重新执行节点");
      return { stop: false, restart_node: true };
    }
    const outcome = await runGateOnce(current);
    if (!outcome.recheck) return outcome;
    current = { ...run, pending: undefined };
  }
}

export interface GateEvaluation {
  checks: Array<{ ref: string; result: GateResult["result"]; reason: string }>;
  anchors: Anchor[];
  confidence: number;
  reason: string;
  satisfied: boolean;
  result: "pass" | "warn";
  evaluation_hash: string;
}

/** gate 的唯一求值入口；server 校验审批时复用，不复制放行状态机。 */
export async function evaluateGate(gate: GateDef, registry: CheckerRegistry, ctx: CheckerContext, input_hash?: string): Promise<GateEvaluation> {
  const checkContext = input_hash === undefined ? ctx : { ...ctx, input_hash };
  const outcomes = await runChecks(gate, registry, checkContext);
  const anchors = dedupeAnchors(outcomes.flatMap((check) => check.result.anchors));
  const confidence = outcomes.length === 0 ? 0 : Math.min(...outcomes.map((check) => check.result.confidence));
  const reason = outcomes.map((check) => `${check.ref}=${check.result.result}（${check.result.reason}）`).join("；");
  return {
    checks: outcomes.map((check) => ({ ref: check.ref, result: check.result.result, reason: check.result.reason })),
    anchors, confidence, reason, satisfied: isSatisfied(gate, outcomes),
    result: outcomes.some((check) => check.result.result === "warn") ? "warn" : "pass",
    evaluation_hash: sha256Hex(canonicalJson({ domain: "cord.gate-evaluation.v1", gate, payload: ctx.payload, anchors: ctx.anchors, outcomes, input_hash,
      ...(ctx.workflow_revision !== undefined ? { workflow_id: ctx.workflow_id, workflow_revision: ctx.workflow_revision } : {}),
    })),
  };
}

async function runGateOnce(run: GateRun): Promise<GateOutcome> {
  const base: GateBase = {
    workflow_id: run.workflow_id,
    workflow_revision: run.workflow_revision,
    node_id: run.node_id,
    gate_id: run.gate.id,
    phase: run.gate.attach.when,
  };

  const input_hash = await run.inputHash?.();
  const evaluation = await evaluateGate(run.gate, run.registry, run.ctx, input_hash);
  const { anchors, confidence, reason, result, evaluation_hash } = evaluation;
  const summaries = evaluation.checks;
  if (run.pending !== undefined && run.pending.evaluation_hash !== evaluation_hash) {
    await invalidateWaiting(run.session, run.actor, base, run.pending.waiting_event_id, "审批依据已变化，重新检查并发起当前审批");
    run = { ...run, pending: undefined };
  }

  if (evaluation.satisfied) {
    if (run.gate.pass.human_confirm) {
      return settleByHuman(run, base, {
        kind: "human_confirm",
        reason,
        result,
        checks: summaries,
        anchors,
        confidence,
        evaluation_hash,
      });
    }
    await appendResolved(run, base, {
      result,
      action: "continue",
      reason,
      checks: summaries,
      anchors,
      confidence,
      human_confirmed: false,
    });
    return { stop: false, summary: { gate_id: run.gate.id, result, action: "continue", reason } };
  }

  switch (run.gate.on_fail) {
    case "warn": {
      const warnReason = `未通过但按 on_fail=warn 放行（强制留痕）：${reason}`;
      await appendResolved(run, base, {
        result: "warn",
        action: "continue",
        reason: warnReason,
        checks: summaries,
        anchors,
        confidence,
        human_confirmed: false,
      });
      return {
        stop: false,
        summary: { gate_id: run.gate.id, result: "warn", action: "continue", reason: warnReason },
      };
    }
    case "escalate":
      return settleByHuman(run, base, {
        kind: "escalation",
        reason,
        checks: summaries,
        anchors,
        confidence,
        evaluation_hash,
      });
    default: {
      const blockReason = `未通过（on_fail=block）：${reason}`;
      await appendResolved(run, base, {
        result: "block",
        action: "stop",
        reason: blockReason,
        checks: summaries,
        anchors,
        confidence,
        human_confirmed: false,
      });
      return {
        stop: true,
        summary: { gate_id: run.gate.id, result: "block", action: "stop", reason: blockReason },
      };
    }
  }
}

interface HumanDecision {
  kind: "human_confirm" | "escalation";
  reason: string;
  result?: "pass" | "warn";
  checks: Array<{ ref: string; result: GateResult["result"]; reason: string }>;
  anchors: Anchor[];
  confidence: number;
  evaluation_hash: string;
}

/**
 * 人工分支：escalate（on_fail=escalate）与 human_confirm（pass 也要人确认）共用。
 * 只给选择题（放行 / 终止），超时按 on_timeout=escalate_human 处理：不放行、保持挂起。
 */
async function settleByHuman(
  run: GateRun,
  base: GateBase,
  decision: HumanDecision,
): Promise<GateOutcome> {
  const question =
    decision.kind === "human_confirm"
      ? `门禁 ${run.gate.id} 校验通过，需人工确认放行：${decision.reason}`
      : `门禁 ${run.gate.id} 未通过，需人工裁决（放行 / 终止）：${decision.reason}`;
  const options = decision.kind === "human_confirm" ? ["确认放行", "拒绝放行"] : ["放行", "终止"];
  const waitingPayload = {
    ...base,
    kind: decision.kind,
    question,
    options,
    reason: decision.reason,
    result: decision.result ?? null,
    evaluation_hash: decision.evaluation_hash,
  };

  const waiting_event_id = run.pending?.waiting_event_id ?? (await appendEvent(
    run.session, run.actor, "gate.waiting", { ...waitingPayload, timed_out: false }, run.node_id,
  )).event_id;

  const answer = await askWithCancel(run.humanGate, question, options, run.gate.timeout, run.signal, { ...base, waiting_event_id, evaluation_hash: decision.evaluation_hash });
  if (answer === CANCELLED) {
    // ADR-0025：run 取消 → 不落 gate.resolved（事实由 workflow.run.cancelled 承载），直接止步
    return { stop: true };
  }
  if (answer === null) {
    await appendEvent(
      run.session,
      run.actor,
      "gate.waiting",
      {
        ...waitingPayload,
        timed_out: true,
        reason: `${decision.reason}｜等待人工超过 ${run.gate.timeout?.after ?? "未配置"}，按 on_timeout=escalate_human 保持挂起（不放行）`,
      },
      run.node_id,
    );
    return { stop: true };
  }

  if (typeof answer !== "string") {
    await invalidateWaiting(run.session, run.actor, base, waiting_event_id, "审批依据变化，宿主请求重新检查");
    return { stop: false, recheck: true };
  }
  const current = await evaluateGate(run.gate, run.registry, run.ctx, await run.inputHash?.());
  if (run.signal?.aborted === true) return { stop: true };
  if (run.checkpointCurrent !== undefined && !(await run.checkpointCurrent())) {
    await invalidateWaiting(run.session, run.actor, base, waiting_event_id, "选择返回时 worker 输入或产物已变化，重新执行节点");
    return { stop: false, restart_node: true };
  }
  if (current.evaluation_hash !== decision.evaluation_hash) {
    await invalidateWaiting(run.session, run.actor, base, waiting_event_id, "选择返回时审批依据已变化，旧选择不用于当前内容");
    return { stop: false, recheck: true };
  }

  if (answer !== options[0]) {
    const reason = `人工未放行（选择「${answer}」）：${decision.reason}`;
    await appendResolved(run, base, {
      result: "block",
      action: "stop",
      reason,
      checks: decision.checks,
      anchors: decision.anchors,
      confidence: decision.confidence,
      human_confirmed: false,
      answer,
      waiting_event_id,
      evaluation_hash: decision.evaluation_hash,
    });
    return { stop: true, summary: { gate_id: run.gate.id, result: "block", action: "stop", reason } };
  }

  const result = decision.result ?? "pass";
  const reason = `人工放行（选择「${answer}」）：${decision.reason}`;
  await appendResolved(run, base, {
    result,
    action: "continue",
    reason,
    checks: decision.checks,
    anchors: decision.anchors,
    confidence: decision.confidence,
    human_confirmed: true,
    answer,
    waiting_event_id,
    evaluation_hash: decision.evaluation_hash,
  });
  return { stop: false, summary: { gate_id: run.gate.id, result, action: "continue", reason } };
}

async function runChecks(
  gate: GateDef,
  registry: CheckerRegistry,
  ctx: CheckerContext,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of gate.checks) {
    // ADR-0024：checks[].with 透传为 CheckerContext.params，checker 自行校验、非法即 block
    const checkCtx: CheckerContext = { ...ctx, params: check.with ?? {} };
    outcomes.push({ ref: check.ref, result: await runOneCheck(check.ref, registry, checkCtx) });
  }
  return outcomes;
}

/** 未注册的 checker 名 / 抛错 / 非法返回值一律 block（fail-closed），不放行。 */
async function runOneCheck(
  ref: string,
  registry: CheckerRegistry,
  ctx: CheckerContext,
): Promise<GateResult> {
  const checker = registry.get(ref);
  if (!checker) {
    return {
      result: "block",
      anchors: [],
      reason: `未知 checker "${ref}"：注册表无此名称，fail-closed 阻断`,
      confidence: 1,
    };
  }
  let raw: unknown;
  try {
    raw = await checker.check(ctx);
  } catch (err) {
    return {
      result: "block",
      anchors: [],
      reason: `checker "${ref}" 执行抛错，fail-closed：${message(err)}`,
      confidence: 1,
    };
  }
  const parsed = GateResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: "block",
      anchors: [],
      reason: `checker "${ref}" 返回值不合法，fail-closed：${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      confidence: 1,
    };
  }
  return parsed.data;
}

/** check 级 warn 视为「有事不阻塞」，只有 block 才算未通过；空 checks 不放行（fail-closed）。 */
function isSatisfied(gate: GateDef, checks: CheckOutcome[]): boolean {
  if (checks.length === 0) return false;
  const ok = checks.filter((check) => check.result.result !== "block");
  return gate.pass.require === "all" ? ok.length === checks.length : ok.length > 0;
}

async function appendResolved(
  run: GateRun,
  base: GateBase,
  fields: {
    result: GateResult["result"];
    action: GateAction;
    reason: string;
    checks: Array<{ ref: string; result: GateResult["result"]; reason: string }>;
    anchors: Anchor[];
    confidence: number;
    human_confirmed: boolean;
    answer?: string;
    waiting_event_id?: string;
    evaluation_hash?: string;
  },
): Promise<void> {
  await appendEvent(
    run.session,
    run.actor,
    "gate.resolved",
    { ...base, ...fields, write_back: run.gate.write_back },
    run.node_id,
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 唯一的写入路径：所有状态变化都落事件流（ADR-0020 单写者）。 */
async function appendEvent(
  session: SessionHandle,
  actor: Actor,
  type: EventType,
  payload: Record<string, unknown>,
  correlationId: string | null,
): Promise<EventEnvelope> {
  const draft: EventDraft = {
    event_id: ulid(),
    session_id: session.req_id,
    type,
    schema_version: "1",
    actor,
    correlation_id: correlationId,
    payload,
    source: { adapter: ADAPTER },
  };
  return session.events.append(draft);
}

async function invalidateWaiting(session: SessionHandle, actor: Actor, base: GateBase, waiting_event_id: string, reason: string): Promise<void> {
  const invalidated = (await session.events.readOrdered()).some((event) =>
    event.type === "gate.invalidated" && asRecord(event.payload)?.["waiting_event_id"] === waiting_event_id,
  );
  if (!invalidated) await appendEvent(session, actor, "gate.invalidated", { ...base, waiting_event_id, reason }, base.node_id);
}

const CANCELLED = Symbol("run-cancelled");

/**
 * 人工提问：超时（null）与取消（CANCELLED）是三态中的两种「未回答」。
 * 取消用 AbortSignal 即刻唤醒（不等人）；超时按 on_timeout=escalate_human 保持挂起。
 */
async function askWithCancel(
  humanGate: HumanGate,
  question: string,
  options: string[],
  timeout: GateDef["timeout"],
  signal?: AbortSignal,
  context?: HumanGateContext,
): Promise<HumanGateAnswer | null | typeof CANCELLED> {
  if (signal?.aborted === true) return CANCELLED;
  const ask = humanGate.ask(question, options, context);
  const racers: Array<Promise<HumanGateAnswer | null | typeof CANCELLED>> = [ask];
  if (timeout) racers.push(delay(parseDuration(timeout.after)));
  let on_abort: (() => void) | undefined;
  if (signal !== undefined) {
    racers.push(
      new Promise<typeof CANCELLED>((resolve) => {
        on_abort = () => resolve(CANCELLED);
        if (signal.aborted) on_abort();
        else signal.addEventListener("abort", on_abort, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (on_abort !== undefined) signal?.removeEventListener("abort", on_abort);
  }
}

/** 门禁挂起超时（等人，量级小时/天）；与 checker 执行超时是两套口径（docs/06 §2.4）。 */
function parseDuration(value: string): number {
  const matched = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!matched) {
    throw new WorkflowDefinitionError(`无法解析 timeout.after："${value}"（形如 30m / 24h / 7d）`);
  }
  const amount = Number(matched[1]);
  const unit = matched[2] ?? "ms";
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return amount * scale;
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
}

function extractAnchors(payload: Record<string, unknown>): Anchor[] {
  const raw = payload["anchors"];
  if (!Array.isArray(raw)) return [];
  const anchors: Anchor[] = [];
  for (const item of raw) {
    const parsed = AnchorSchema.safeParse(item);
    if (parsed.success) anchors.push(parsed.data);
  }
  return anchors;
}

function dedupeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const seen = new Set<string>();
  const out: Anchor[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.kind}#${anchor.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(anchor);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
