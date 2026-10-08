/** 最新快照下的独立协调轮次（ADR-0032）；模型提议由宿主校验，执行仍经 workflow。 */
import { z } from "zod";
import { ulid } from "ulid";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { AgentDriver, ContextSessionAgent, CoordinationInput, CoordinationResult, SessionHandle } from "../core/ports.js";
import { AgentUsagePayloadSchema, CoordinationProposalSchema, CoordinationVerificationsSchema, type CoordinationVerification, type CoordinationProposal, type CoordinationStatus, type WorkflowDef } from "../core/schema.js";
import { DEFAULT_TASK_TIMEOUT_MS } from "../driver/headless.js";
import { topologicalOrder } from "../workflow/executor.js";
import type { RequirementSnapshot } from "./snapshot.js";
import { buildCoordinationDocuments, COORDINATION_CONTEXT_POLICY, readCoordinationSnapshot } from "./coordination-context.js";

const ADAPTER = "context-session-agent";
const ABORTED = Symbol("aborted");
const DEFAULT_MAX_PROMPT_CHARS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_768;
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
}

/** 轮次自己的事件不会改变输入；文档、账本、进度与人工等待会改变。 */
export function coordinationInputHash(def: WorkflowDef, snapshot: RequirementSnapshot, configuration_hash: string | null, max_prompt_chars = DEFAULT_MAX_PROMPT_CHARS, source_hash: string | null = null, verifications: readonly CoordinationVerification[] = []): string {
  return sha256Hex(canonicalJson({
    domain: "cord.coordination-input.v4", context_policy: COORDINATION_CONTEXT_POLICY, workflow: def, configuration_hash, max_prompt_chars,
    ...(source_hash === null ? {} : { source_hash }),
    ...(verifications.length === 0 ? {} : { verifications }),
    ...(snapshot.workflow_revision !== undefined ? { workflow_revision: snapshot.workflow_revision } : {}),
    req_id: snapshot.req_id, title: snapshot.title,
    docs: snapshot.docs.map(({ file, exists, content_hash }) => ({ file, exists, content_hash })),
    ledger: snapshot.ledger,
    workflow_progress: { ...snapshot.workflow, waiting: snapshot.workflow.waiting ?? [] },
  }));
}

function eligibleNodes(def: WorkflowDef, snapshot: RequirementSnapshot): string[] {
  if ((snapshot.workflow.waiting?.length ?? 0) > 0) return [];
  const exited = new Set(snapshot.workflow.exited);
  const next_id = topologicalOrder(def).find((id) => !exited.has(id));
  const node = def.spec.nodes.find((item) => item.id === next_id);
  return node !== undefined && node.depends_on.every((id) => exited.has(id)) ? [node.id] : [];
}

/** 只接受完整 JSON；来源存在性与 workflow 依赖是宿主判定，不能由模型自报。 */
export function parseCoordinationProposal(text: string, def: WorkflowDef, snapshot: RequirementSnapshot, verifications: readonly CoordinationVerification[] = []): CoordinationProposal {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("协调结果必须是完整 JSON 对象"); }
  const parsed = CoordinationProposalSchema.safeParse(value);
  if (!parsed.success) throw new Error(`协调提议不符合契约：${parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").join("、")}`);
  const proposal = parsed.data;
  const action = proposal.next_action;
  if (action.kind === "advance" && !eligibleNodes(def, snapshot).includes(action.node_id)) throw new Error("协调提议引用了不可推进的节点（依赖、进度或人工 gate 未满足）");
  if (action.kind === "complete" && ((snapshot.workflow.waiting?.length ?? 0) > 0 || !def.spec.nodes.every((node) => snapshot.workflow.exited.includes(node.id)))) throw new Error("工作流尚未完成，不能提议 complete");
  if (action.kind === "ask_human" && new Set(action.options).size !== action.options.length) throw new Error("人工选择题选项必须互不相同");
  for (const evidence of action.evidence) {
    const valid = evidence.source === "document" ? snapshot.docs.some((doc) => doc.file === evidence.id && doc.exists) :
      evidence.source === "ledger" ? snapshot.ledger.some((entry) => entry.entry_id === evidence.id && entry.status === "confirmed" && !entry.conflict) :
      evidence.source === "verification" ? verifications.some((result) => result.event_id === evidence.id && result.current === true && result.status !== "missing" && result.status !== "invalid") :
      def.spec.nodes.some((node) => node.id === evidence.id);
    if (!valid) throw new Error(`协调提议的来源引用不可验证：${evidence.source}/${evidence.id}`);
  }
  return proposal;
}

export function buildCoordinationPrompt(def: WorkflowDef, snapshot: RequirementSnapshot, max_chars = DEFAULT_MAX_PROMPT_CHARS, source_hash: string | null = null, verifications: readonly CoordinationVerification[] = []): string {
  if (!Number.isSafeInteger(max_chars) || max_chars < 0) throw new Error("协调上下文预算必须是非负安全整数");
  topologicalOrder(def);
  const fixed = [
    "# Context Session Agent：当前需求的协调者",
    "分析最新快照，提出下一步。只产 Draft；不调用工具、不写文件、不启动 worker、不放行 gate。不要读取事件流或旧会话历史。",
    "返回一个严格 JSON 对象，禁止 Markdown 围栏和额外解释。证据引用只允许本包的文档、无冲突 confirmed 条目、workflow 节点或 current=true 的验证 event_id。",
    `context_policy: ${COORDINATION_CONTEXT_POLICY}\n文档按首尾片段提供，document_excerpts 标明 UTF-16 字符范围和省略数。未显示的内容不能声称已核验；材料不足时请选择 wait 或 ask_human。`,
    `workflow 来源的 id 只能是 node.id（${JSON.stringify(def.spec.nodes.map((node) => node.id))}），不能是 gate.id；verification 来源的 id 只能是 current=true 观察的 event_id。`,
    "advance 只可选择 eligible_nodes；该提议不代表机器 checker 或人工审批已放行。等待人工 gate 时请选择 ask_human 或 wait。",
    `req_id: ${snapshot.req_id}\ntitle: ${snapshot.title ?? "（未命名）"}`,
    `workflow: ${JSON.stringify(def)}`,
    ...(snapshot.workflow_revision !== undefined ? [`workflow_revision: ${snapshot.workflow_revision}`] : []),
    ...(source_hash === null ? [] : [`source_hash: ${source_hash}\n源码摘要仅标识当前声明范围，不代表测试通过或内容已被核验。`]),
    ...(verifications.length === 0 ? [] : [`verifications: ${JSON.stringify(verifications)}\n机器观察由宿主核验输入身份。missing、invalid、current=false/null 均不能认作当前通过；当前 failed/timeout/cancelled 也不是通过。验证证据不能代替人工 gate。`]),
    `progress: ${JSON.stringify(snapshot.workflow)}`,
    `eligible_nodes: ${JSON.stringify(eligibleNodes(def, snapshot))}`,
    `ledger: ${JSON.stringify(snapshot.ledger)}`,
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
    try {
      snapshot = await readCoordinationSnapshot(def, session, input.workflow_revision);
      Object.assign(base, { snapshot_id: snapshot.snapshot_id, snapshot_event_seq: snapshot.event_seq, snapshot_event_chain_hash: snapshot.event_chain_hash });
      source_hash = await read_source_hash(def);
      if (source_hash !== null) base["source_hash"] = source_hash;
      verifications = await read_verifications(def, session, input.workflow_revision);
      if (verifications.length > 0) base["verification_context_hash"] = sha256Hex(canonicalJson(verifications));
      prompt = buildCoordinationPrompt(def, snapshot, max_prompt_chars, source_hash, verifications);
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
      base["input_hash"] = coordinationInputHash(def, snapshot, driver.configuration_hash ?? null, max_prompt_chars, source_hash, verifications);
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
          if (event.type === "text") {
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
      failure = { status: "failed", error: error instanceof Error ? error.message.slice(0, 2_000) : "协调 driver 运行失败", failure_stage: "driver" };
    } finally { clearTimeout(timer); }
    if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
    if (timed_out) return complete("timeout", null, "协调轮次超时", { ...extra, failure_stage: "driver" });
    if (failure !== null) return complete(failure.status, null, failure.error, { ...extra, failure_stage: failure.failure_stage });
    const text = result_text ?? chunks;
    extra["response_hash"] = sha256Hex(text);
    let proposal: CoordinationProposal;
    try { proposal = parseCoordinationProposal(text, def, snapshot, verifications); }
    catch (error) { return complete("failed", null, error instanceof Error ? error.message : "协调输出校验失败", { ...extra, failure_stage: "output" }); }
    try {
      const current = await readCoordinationSnapshot(def, session, input.workflow_revision);
      const current_source = await read_source_hash(def);
      const current_verifications = await read_verifications(def, session, input.workflow_revision);
      if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
      if (coordinationInputHash(def, current, driver.configuration_hash ?? null, max_prompt_chars, current_source, current_verifications) !== base["input_hash"]) {
        return complete("stale", null, "协调期间需求、源码、验证、账本或 workflow 进度已变化，请重新协调", { ...extra, failure_stage: "freshness" });
      }
    } catch (error) {
      return complete("failed", null, error instanceof Error ? error.message : "协调输入重检失败", { ...extra, failure_stage: "freshness" });
    }
    if (input.signal?.aborted) return complete("cancelled", null, "协调轮次已取消", extra);
    return complete("ok", proposal, null, extra);
  }
}
