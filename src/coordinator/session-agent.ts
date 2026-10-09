/** 最新快照下的独立协调轮次（ADR-0032）；模型提议由宿主校验，执行仍经 workflow。 */
import { z } from "zod";
import { ulid } from "ulid";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { AgentDriver, ContextSessionAgent, CoordinationInput, CoordinationResult, SessionHandle } from "../core/ports.js";
import { AgentUsagePayloadSchema, CoordinationProposalSchema, CoordinationVerificationsSchema, CoordinationExecutionContextSchema,
  GoalBlockerTriggerSchema, type GoalBlockerTrigger, type CoordinationExecutionContext, type CoordinationExecutionContextInput, type CoordinationVerification, type CoordinationProposal, type CoordinationStatus, type WorkflowDef } from "../core/schema.js";
import { DEFAULT_TASK_TIMEOUT_MS } from "../driver/headless.js";
import { topologicalOrder } from "../workflow/executor.js";
import type { RequirementSnapshot } from "./snapshot.js";
import { buildCoordinationDocuments, COORDINATION_CONTEXT_POLICY, readCoordinationSnapshot } from "./coordination-context.js";
import { goalAcceptanceIsComplete } from "./goal-acceptance.js";

function assertGoalAcceptance(def: WorkflowDef, execution_context?: CoordinationExecutionContext): void {
  for (const observation of execution_context?.goals ?? []) {
    if (observation.current !== true && observation.acceptance_evidence === undefined) continue;
    const goal = def.spec.nodes.find(node => node.id === observation.node_id)?.run?.goal;
    if (goal === undefined || !goalAcceptanceIsComplete(goal, observation.acceptance_evidence, observation.verification_event_ids)) throw new Error("协调 Goal 验收覆盖与发布条件不一致");
  }
}

const ADAPTER = "context-session-agent";
const ABORTED = Symbol("aborted");
const DEFAULT_MAX_PROMPT_CHARS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_768;
const COORDINATION_TOOL_POLICY = "none.v1";
const driver_text_schema = z.object({ text: z.string(), channel: z.enum(["content", "metadata"]).optional() });
const driver_result_schema = z.object({ text: z.string().nullable(), session_id: z.string().nullable().optional(), usage: z.object(AgentUsagePayloadSchema.shape).nullable().optional() });
const driver_error_schema = z.object({ message: z.string(), kind: z.string() });

export interface ContextSessionAgentOptions {
  resolveDriver: (name: string) => AgentDriver;
  workspaceRoot: string;
  maxPromptChars?: number;
  maxOutputChars?: number;
  /** ADR-0043：宿主读取绑定流程声明的源码范围摘要，null 为无绑定。 */
  read_source_hash?: (def: WorkflowDef) => Promise<string | null>;
  /** ADR-0044：宿主投影当前流程声明的验证结果与新鲜度，不携带日志。 */
  read_verifications?: (def: WorkflowDef, session: SessionHandle, workflow_revision?: string) => Promise<CoordinationVerification[]>;
  /** ADR-0048：当前 run 与 worker 状态，不携带任务正文或错误日志。 */
  read_execution_context?: (def: WorkflowDef, session: SessionHandle, workflow_revision?: string) => Promise<CoordinationExecutionContextInput>;
}

/** 轮次自己的事件不会改变输入；文档、账本、进度与人工等待会改变。 */
export function coordinationInputHash(def: WorkflowDef, snapshot: RequirementSnapshot, configuration_hash: string | null, max_prompt_chars = DEFAULT_MAX_PROMPT_CHARS, source_hash: string | null = null, verifications: readonly CoordinationVerification[] = [], execution_context?: CoordinationExecutionContext, goal_blocker?: GoalBlockerTrigger): string {
  const clarifications = snapshot.clarifications ?? [];
  return sha256Hex(canonicalJson({
    domain: execution_context === undefined ? (clarifications.length === 0 ? "cord.coordination-input.v5" : "cord.coordination-input.v6") : (clarifications.length === 0 ? "cord.coordination-input.v7" : "cord.coordination-input.v8"), context_policy: COORDINATION_CONTEXT_POLICY,
    ...(clarifications.length === 0 ? {} : { clarifications }),
    tool_policy: COORDINATION_TOOL_POLICY, workflow: def, configuration_hash, max_prompt_chars,
    ...(execution_context === undefined ? {} : { execution_context }),
    ...(goal_blocker === undefined ? {} : { goal_blocker }),
    ...(source_hash === null ? {} : { source_hash }),
    ...(verifications.length === 0 ? {} : { verifications }),
    ...(snapshot.workflow_revision !== undefined ? { workflow_revision: snapshot.workflow_revision } : {}),
    req_id: snapshot.req_id, title: snapshot.title,
    docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
    workflow_progress: { ...snapshot.workflow, waiting: snapshot.workflow.waiting ?? [] },
  }));
}

function eligibleNodes(def: WorkflowDef, snapshot: RequirementSnapshot, execution_context?: CoordinationExecutionContext): string[] {
  if ((snapshot.workflow.waiting?.length ?? 0) > 0 || execution_context?.run?.active === true) return [];
  if (execution_context?.goals?.some((goal) => ["blocked", "invalid", "cancelled"].includes(goal.status))) return [];
  const exited = new Set(snapshot.workflow.exited);
  const next_id = topologicalOrder(def).find((id) => !exited.has(id));
  const node = def.spec.nodes.find((item) => item.id === next_id);
  return node !== undefined && node.depends_on.every((id) => exited.has(id)) ? [node.id] : [];
}

function assertGoalBlocker(execution_context: CoordinationExecutionContext | undefined, goal_blocker: GoalBlockerTrigger): void {
  const target = GoalBlockerTriggerSchema.parse(goal_blocker);
  if (!execution_context?.goals?.some(goal => goal.node_id === target.node_id && goal.run_id === target.run_id && goal.event_id === target.goal_event_id && goal.status === "blocked")) throw new Error("自动协调的 Goal 阻塞依据已变化");
}

/** 只接受完整 JSON；来源存在性与 workflow 依赖是宿主判定，不能由模型自报。 */
export function parseCoordinationProposal(text: string, def: WorkflowDef, snapshot: RequirementSnapshot, verifications: readonly CoordinationVerification[] = [], execution_context?: CoordinationExecutionContext, goal_blocker?: GoalBlockerTrigger): CoordinationProposal {
  assertGoalAcceptance(def, execution_context);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("协调结果必须是完整 JSON 对象"); }
  const parsed = CoordinationProposalSchema.safeParse(value);
  if (!parsed.success) throw new Error(`协调提议不符合契约：${parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").join("、")}`);
  const proposal = parsed.data;
  const action = proposal.next_action;
  if (action.kind === "advance" && !eligibleNodes(def, snapshot, execution_context).includes(action.node_id)) throw new Error("协调提议引用了不可推进的节点（依赖、进度、人工 gate 或活动 run 未满足）");
  if (action.kind === "complete" && (execution_context?.run?.active === true || (snapshot.workflow.waiting?.length ?? 0) > 0 || !def.spec.nodes.every((node) => snapshot.workflow.exited.includes(node.id)))) throw new Error("工作流尚未完成，不能提议 complete");
  if (action.kind === "ask_human" && new Set(action.options).size !== action.options.length) throw new Error("人工选择题选项必须互不相同");
  if (goal_blocker !== undefined) {
    assertGoalBlocker(execution_context, goal_blocker);
    if (!["ask_human", "wait"].includes(action.kind) || !action.evidence.some(item => item.source === "goal" && item.id === goal_blocker.goal_event_id)) throw new Error("自动 Goal 协调必须等待或升级人工，并引用绑定的 blocker");
  }
  for (const evidence of action.evidence) {
    const valid = evidence.source === "document" ? snapshot.docs.some((doc) => doc.file === evidence.id && doc.exists) :
      evidence.source === "ledger" ? snapshot.ledger.some((entry) => entry.entry_id === evidence.id && entry.status === "confirmed" && !entry.conflict) :
      evidence.source === "verification" ? verifications.some((result) => result.event_id === evidence.id && result.current === true && result.status !== "missing" && result.status !== "invalid") :
      evidence.source === "agent_task" ? execution_context?.tasks.some((task) => task.event_id === evidence.id && !["missing", "invalid"].includes(task.status)) === true :
      evidence.source === "goal" ? execution_context?.goals?.some((goal) => goal.event_id === evidence.id && !["missing", "invalid"].includes(goal.status)
        && (goal.status !== "ready" || goal.current === true)) === true :
      evidence.source === "clarification" ? snapshot.clarifications?.some((answer) => answer.event_id === evidence.id) === true :
      def.spec.nodes.some((node) => node.id === evidence.id);
    if (!valid) throw new Error(`协调提议的来源引用不可验证：${evidence.source}/${evidence.id}`);
  }
  return proposal;
}

export function buildCoordinationPrompt(def: WorkflowDef, snapshot: RequirementSnapshot, max_chars = DEFAULT_MAX_PROMPT_CHARS, source_hash: string | null = null, verifications: readonly CoordinationVerification[] = [], execution_context?: CoordinationExecutionContext, goal_blocker?: GoalBlockerTrigger): string {
  assertGoalAcceptance(def, execution_context);
  if (!Number.isSafeInteger(max_chars) || max_chars < 0) throw new Error("协调上下文预算必须是非负安全整数");
  topologicalOrder(def);
  if (goal_blocker !== undefined) assertGoalBlocker(execution_context, goal_blocker);
  const fixed = [
    "# Context Session Agent：当前需求的协调者",
    "分析最新快照，提出下一步。只产 Draft；不调用工具、不写文件、不启动 worker、不放行 gate。不要读取事件流或旧会话历史。",
    `tool_policy: ${COORDINATION_TOOL_POLICY}\n宿主拒绝任何工具通知，包括只读工具或工具结果；只分析本包已有内容。`,
    "返回一个严格 JSON 对象，禁止 Markdown 围栏和额外解释。证据引用只允许本包的文档、无冲突 confirmed 条目、workflow 节点、current=true 的验证 event_id 或合法当前 run 的 agent_task event_id。",
    `context_policy: ${COORDINATION_CONTEXT_POLICY}\n文档按首尾片段提供，document_excerpts 标明 UTF-16 字符范围和省略数。未显示的内容不能声称已核验；材料不足时请选择 wait 或 ask_human。`,
    `workflow 来源的 id 只能是 node.id（${JSON.stringify(def.spec.nodes.map((node) => node.id))}），不能是 gate.id；verification 来源的 id 只能是 current=true 观察的 event_id；goal 来源的 id 只能是当前 Goal 尝试 event_id。`,
    "advance 只可选择 eligible_nodes；该提议不代表机器 checker 或人工审批已放行。存在 blocked/invalid/cancelled Goal 时 eligible_nodes 为空，只能依据当前 Goal 事件提出 ask_human 或 wait，不能自行扩充预算、批准权限或放行 gate。",
    `req_id: ${snapshot.req_id}\ntitle: ${snapshot.title ?? "（未命名）"}`,
    ...(goal_blocker === undefined ? [] : [`goal_blocker: ${JSON.stringify(goal_blocker)}\n这是宿主自动发起的阻塞解释。只可返回 ask_human 或 wait，必须引用此 goal_event_id；说明已尝试的自动修复、缺少的事实或权限以及最小人工决定，不自动扩充预算、回答问题或恢复 run。`]),
    `workflow: ${JSON.stringify(def)}`,
    ...(snapshot.workflow_revision !== undefined ? [`workflow_revision: ${snapshot.workflow_revision}`] : []),
    ...(source_hash === null ? [] : [`source_hash: ${source_hash}\n源码摘要仅标识当前声明范围，不代表测试通过或内容已被核验。`]),
    ...(verifications.length === 0 ? [] : [`verifications: ${JSON.stringify(verifications)}\n机器观察由宿主核验输入身份。missing、invalid、current=false/null 均不能认作当前通过；当前 failed/timeout/cancelled 也不是通过。验证证据不能代替人工 gate。`]),
    ...(execution_context === undefined ? [] : [`execution_context: ${JSON.stringify(!execution_context.goals?.length ? { run: execution_context.run, tasks: execution_context.tasks } : execution_context)}\nactive 仅标识宿主当前运行槽位，active=true 时不得推进新 run。started 只证明启动已记录，active=false 时不能声称进程仍活着。reused 表示当前 run 复用原完成事件 completion_event_id，没有新的 worker 调用；来源仍用当前复用 event_id。任务事实不保证对应修改后的输入，ok/reused 也不等于测试或 gate 通过；missing/invalid 不能引用，agent_task 来源只用这里的合法 event_id。Goal ready 只有 current=true 才是当前有效交付，current=false/null 表示过期或不可读取，不能作为 ready 来源；历史状态保留，freshness_reason 说明当前核验结果。Goal status=blocked/invalid/cancelled 时不能 advance，应使用当前 goal event 作为证据提出 ask_human 或 wait。`]),
    `progress: ${JSON.stringify(snapshot.workflow)}`,
    `eligible_nodes: ${JSON.stringify(eligibleNodes(def, snapshot, execution_context))}`,
    `ledger: ${JSON.stringify(snapshot.ledger)}`,
    ...((snapshot.clarifications?.length ?? 0) === 0 ? [] : [`clarifications: ${JSON.stringify(snapshot.clarifications)}\n人工澄清只说明原问题的选择，不是测试、gate 或执行授权；status=revoked/choice=null 表示未确定，不能沿用已撤回选项。与最新材料矛盾时需重新询问，来源使用当前答复或撤回 event_id。`]),
    `documents: ${JSON.stringify(snapshot.docs.map(({ file, exists, content_hash, content_length }) => ({ file, exists, content_hash, content_length })))}`,
    `response_schema: ${JSON.stringify(z.toJSONSchema(CoordinationProposalSchema))}`,
  ].join("\n\n");
  if (fixed.length > max_chars) throw new Error("协调输入的必需元信息超过上下文预算，请缩小 workflow 或账本");
  return fixed + buildCoordinationDocuments(snapshot.docs, max_chars - fixed.length);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  let on_abort = (): void => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    on_abort = () => resolve(ABORTED);
    if (signal.aborted) on_abort();
    else signal.addEventListener("abort", on_abort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", on_abort); }
}

export function createContextSessionAgent(options: ContextSessionAgentOptions): ContextSessionAgent {
  return { coordinate };

  async function read_execution_context(def: WorkflowDef, session: SessionHandle, workflow_revision?: string): Promise<CoordinationExecutionContext | undefined> {
    if (options.read_execution_context === undefined) return undefined;
    const parsed = CoordinationExecutionContextSchema.safeParse(await options.read_execution_context(def, session, workflow_revision));
    if (!parsed.success) throw new Error("协调执行观察不符合契约");
    const nodes = def.spec.nodes.filter((node) => node.run !== undefined);
    if (parsed.data.tasks.length !== nodes.length || parsed.data.tasks.some((task) => !nodes.some((node) => node.id === task.node_id))) {
      throw new Error("协调执行观察必须完整覆盖声明的 worker 节点");
    }
    parsed.data.tasks.sort((a, b) => a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0);
    const goal_nodes = def.spec.nodes.filter((node) => node.run?.goal !== undefined);
    if (parsed.data.goals.length !== goal_nodes.length || parsed.data.goals.some((goal) => !goal_nodes.some((node) => node.id === goal.node_id))) {
      throw new Error("协调 Goal 观察必须完整覆盖声明的 Goal 节点");
    }
    parsed.data.goals.sort((a, b) => a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0);
    assertGoalAcceptance(def, parsed.data);
    return parsed.data;
  }

  async function read_source_hash(def: WorkflowDef): Promise<string | null> {
    if (options.read_source_hash === undefined) return null;
    const hash = await options.read_source_hash(def);
    if (hash !== null && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) throw new Error("协调源码摘要必须是小写 SHA-256 或 null");
    return hash;
  }

  async function read_verifications(def: WorkflowDef, session: SessionHandle, workflow_revision?: string): Promise<CoordinationVerification[]> {
    if (options.read_verifications === undefined) return [];
    const parsed = CoordinationVerificationsSchema.safeParse(await options.read_verifications(def, session, workflow_revision));
    if (!parsed.success) throw new Error("协调机器验证观察不符合契约");
    for (const result of parsed.data) {
      const node = def.spec.nodes.find((item) => item.id === result.node_id);
      if (!node?.gates.some((gate) => gate.checks.some((check) => check.ref === "verification-passed" && check.with?.["verification_id"] === result.verification_id))) {
        throw new Error("协调机器验证观察引用了未声明的检查");
      }
    }
    return parsed.data.sort((a, b) => {
      const first = JSON.stringify([a.node_id, a.verification_id]);
      const second = JSON.stringify([b.node_id, b.verification_id]);
      return first < second ? -1 : first > second ? 1 : 0;
    });
  }

  async function coordinate(def: WorkflowDef, session: SessionHandle, input: CoordinationInput): Promise<CoordinationResult> {
    const started_at = Date.now();
    const base: Record<string, unknown> = { round_id: input.round_id, workflow_id: def.metadata.id, driver: input.agent };
    if (input.workflow_revision !== undefined) base["workflow_revision"] = input.workflow_revision;
    const append = async (type: "coordinator.round.started" | "coordinator.round.completed", payload: Record<string, unknown>) => session.events.append({
      event_id: ulid(), session_id: session.req_id, type, schema_version: "1",
      actor: { kind: "agent", id: ADAPTER }, correlation_id: input.round_id, payload, source: { adapter: ADAPTER },
    });
    const complete = async (status: CoordinationStatus, proposal: CoordinationProposal | null, error: string | null, extra: Record<string, unknown> = {}): Promise<CoordinationResult> => {
      const event = await append("coordinator.round.completed", { ...base, status, proposal, error, duration_ms: Date.now() - started_at, ...extra });
      return { round_id: input.round_id, status, proposal, error, completed_event_id: event.event_id };
    };
    const max_prompt_chars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    const max_output_chars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    let snapshot: RequirementSnapshot;
    let prompt: string;
    let source_hash: string | null = null;
    let verifications: CoordinationVerification[] = [];
    let execution_context: CoordinationExecutionContext | undefined;
    try {
      snapshot = await readCoordinationSnapshot(def, session, input.workflow_revision);
      Object.assign(base, { snapshot_id: snapshot.snapshot_id, snapshot_event_seq: snapshot.event_seq, snapshot_event_chain_hash: snapshot.event_chain_hash });
      source_hash = await read_source_hash(def);
      if (source_hash !== null) base["source_hash"] = source_hash;
      verifications = await read_verifications(def, session, input.workflow_revision);
      if (verifications.length > 0) base["verification_context_hash"] = sha256Hex(canonicalJson(verifications));
      execution_context = await read_execution_context(def, session, input.workflow_revision);
      if (execution_context !== undefined) base["execution_context_hash"] = sha256Hex(canonicalJson(execution_context));
      if (input.goal_blocker !== undefined) GoalBlockerTriggerSchema.parse(input.goal_blocker);
      prompt = buildCoordinationPrompt(def, snapshot, max_prompt_chars, source_hash, verifications, execution_context, input.goal_blocker);
    } catch (error) {
      await append("coordinator.round.started", base);
      return complete("failed", null, error instanceof Error ? error.message : "协调快照准备失败", { failure_stage: "snapshot" });
    }
    let driver: AgentDriver;
    try {
      driver = options.resolveDriver(input.agent);
      if (typeof driver.name !== "string" || driver.name.length === 0 || (driver.configuration_hash !== undefined && !/^[0-9a-f]{64}$/.test(driver.configuration_hash))) throw new Error("协调 driver 身份不符合契约");
      base["driver"] = driver.name;
      if (driver.configuration_hash !== undefined) base["agent_configuration_hash"] = driver.configuration_hash;
      base["input_hash"] = coordinationInputHash(def, snapshot, driver.configuration_hash ?? null, max_prompt_chars, source_hash, verifications, execution_context, input.goal_blocker);
      base["prompt_hash"] = sha256Hex(prompt);
    } catch (error) {
      await append("coordinator.round.started", base);
      return complete("failed", null, error instanceof Error ? error.message : "协调 driver 解析失败", { failure_stage: "configuration" });
    }
    await append("coordinator.round.started", base);
    if (input.signal?.aborted === true) return complete("cancelled", null, "协调轮次已取消");

    const controller = new AbortController();
    const signal = input.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, input.signal]);
    let timed_out = false;
    const timeout_ms = input.timeout_ms ?? DEFAULT_TASK_TIMEOUT_MS;
    const timer = setTimeout(() => { timed_out = true; controller.abort(); }, timeout_ms);
    let chunks = "";
    let result_text: string | null = null;
    const extra: Record<string, unknown> = {};
    let failure: { status: CoordinationStatus; error: string; failure_stage: string } | null = null;
    try {
      const iterator = driver.run({ prompt, cwd: options.workspaceRoot, readonly: true, timeout_ms, signal })[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await raceAbort(iterator.next(), signal);
          if (next === ABORTED || next.done) break;
          const event = next.value;
          if (event.session_id != null) {
            if (typeof event.session_id !== "string") throw new Error("协调 driver 会话回执不符合契约");
            extra["agent_session_id"] = event.session_id;
          }
          if (event.type === "tool_use") {
            failure = { status: "failed", error: "独立协调轮次禁止使用工具，请修正 Agent 配置后重新协调", failure_stage: "driver" };
            controller.abort();
            break;
          } else if (event.type === "text") {
            const parsed = driver_text_schema.safeParse(event.data);
            if (!parsed.success) throw new Error("协调 driver 文本事件不符合契约");
            const data = parsed.data;
            if (data.channel !== "metadata") {
              if (chunks.length + data.text.length > max_output_chars) {
                failure = { status: "failed", error: "协调输出超过大小上限", failure_stage: "output" };
                controller.abort();
                break;
              }
              chunks += data.text;
            }
          } else if (event.type === "result") {
            const parsed = driver_result_schema.safeParse(event.data);
            if (!parsed.success) throw new Error("协调 driver 结果事件不符合契约");
            const data = parsed.data;
            result_text = data.text;
            extra["agent_session_id"] = data.session_id ?? extra["agent_session_id"] ?? null;
            extra["usage"] = data.usage ?? null;
          } else if (event.type === "error") {
            const parsed = driver_error_schema.safeParse(event.data);
            if (!parsed.success) throw new Error("协调 driver 错误事件不符合契约");
            const data = parsed.data;
            failure = { status: data.kind === "timeout" ? "timeout" : "failed", error: data.message.slice(0, 2_000), failure_stage: "driver" };
            break;
          }
          if (chunks.length > max_output_chars || (result_text?.length ?? 0) > max_output_chars) {
            failure = { status: "failed", error: "协调输出超过大小上限", failure_stage: "output" };
            controller.abort();
            break;
          }
        }
      } finally { await iterator.return?.(); }
    } catch (error) {
      failure ??= { status: "failed", error: error instanceof Error ? error.message.slice(0, 2_000) : "协调 driver 运行失败", failure_stage: "driver" };
    } finally { clearTimeout(timer); }
    if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
    if (timed_out) return complete("timeout", null, "协调轮次超时", { ...extra, failure_stage: "driver" });
    if (failure !== null) return complete(failure.status, null, failure.error, { ...extra, failure_stage: failure.failure_stage });
    const text = result_text ?? chunks;
    extra["response_hash"] = sha256Hex(text);
    let proposal: CoordinationProposal;
    try { proposal = parseCoordinationProposal(text, def, snapshot, verifications, execution_context, input.goal_blocker); }
    catch (error) { return complete("failed", null, error instanceof Error ? error.message : "协调输出校验失败", { ...extra, failure_stage: "output" }); }
    try {
      const current = await readCoordinationSnapshot(def, session, input.workflow_revision);
      const current_source = await read_source_hash(def);
      const current_verifications = await read_verifications(def, session, input.workflow_revision);
      const current_execution = await read_execution_context(def, session, input.workflow_revision);
      if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
      if (coordinationInputHash(def, current, driver.configuration_hash ?? null, max_prompt_chars, current_source, current_verifications, current_execution, input.goal_blocker) !== base["input_hash"]) {
        return complete("stale", null, "协调期间需求、源码、验证、账本或 workflow 进度已变化，请重新协调", { ...extra, failure_stage: "freshness" });
      }
    } catch (error) {
      return complete("failed", null, error instanceof Error ? error.message : "协调输入重检失败", { ...extra, failure_stage: "freshness" });
    }
    if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
    return complete("ok", proposal, null, extra);
  }
}
