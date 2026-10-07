/**
 * 内置 checker 注册表（ADR-0014 的 L1 档：平台预置、按名引用）。
 *
 * fail-closed 约定：无法判定（注册表无此名由执行器兜底、账本读不到、锚点不合法）一律返回
 * `block`，不放行——「无证据不入账」对门禁结论同样成立。
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readSessionDocument, statSessionDocument } from "../core/session-files.js";
import { z } from "zod";
import { matchesWorkflowScope } from "./scope.js";
import {
  AnchorSchema,
  EventEnvelopeSchema,
  LedgerSchema,
  type Anchor,
  type EventEnvelope,
  type GateResult,
  type Ledger,
  type WorkflowDef,
} from "../core/schema.js";
import type { Checker, CheckerContext, CheckerRegistry, SessionHandle } from "../core/ports.js";
import { createReducer } from "../core/reducer.js";

export const BUILTIN_CHECKER_NAMES = [
  "anchors-present",
  "ledger-has-confirmed",
  "vote-confirmed",
  "file-exists",
  "file-nonempty",
  "doc-has-section",
  "anchors-min-count",
  "event-emitted",
] as const;
export type BuiltinCheckerName = (typeof BUILTIN_CHECKER_NAMES)[number];

export interface BuiltinRegistryOptions {
  /** 兜底绑定的 session（执行器已通过 `ctx.session` 给出，通常不需要；跨进程调用者才用得上） */
  session?: SessionHandle;
  /** 无 session 时可注入最新投影；默认从 `<session_dir>/events.jsonl` 严格读取并派生 */
  readLedger?: (session_dir: string) => Promise<Ledger>;
}

export function createBuiltinRegistry(options: BuiltinRegistryOptions = {}): CheckerRegistry {
  const checkers = new Map<string, Checker>();
  for (const checker of [
    createAnchorsPresentChecker(),
    createLedgerHasConfirmedChecker(options),
    createVoteConfirmedChecker(),
    createFileExistsChecker(),
    createFileNonemptyChecker(),
    createDocHasSectionChecker(),
    createAnchorsMinCountChecker(),
    createEventEmittedChecker(),
  ]) {
    checkers.set(checker.name, checker);
  }
  return {
    register(checker: Checker): void {
      checkers.set(checker.name, checker);
    },
    get(name: string): Checker | undefined {
      return checkers.get(name);
    },
  };
}

/** 加载期校验用：返回 workflow 中引用了但注册表里不存在的 checker 名（宿主应拒绝加载） */
export function findUnknownCheckers(def: WorkflowDef, registry: CheckerRegistry): string[] {
  const unknown = new Set<string>();
  for (const node of def.spec.nodes) {
    for (const gate of node.gates) {
      for (const check of gate.checks) {
        if (!registry.get(check.ref)) unknown.add(check.ref);
      }
    }
  }
  return [...unknown];
}

// ---------------------------------------------------------------------------
// 内置 checker
// ---------------------------------------------------------------------------

/** 锚点来源：`payload.anchors` 优先，缺省退回 `ctx.anchors`（端口本就是给执行器传锚点的通道）；须非空且至少一个合法。 */
export function createAnchorsPresentChecker(): Checker {
  return {
    name: "anchors-present",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const fromPayload = ctx.payload["anchors"];
      const raw = Array.isArray(fromPayload) ? fromPayload : ctx.anchors;
      const source = Array.isArray(fromPayload) ? "payload.anchors" : "ctx.anchors";
      if (raw.length === 0) {
        return block(`${source} 为空：无证据锚点不放行`);
      }
      const { anchors, invalid } = parseAnchors(raw);
      if (anchors.length === 0) {
        return block(`${source} 有 ${raw.length} 项但无一合法（无效 ${invalid} 项）`);
      }
      const detail = invalid > 0 ? `，忽略非法锚点 ${invalid} 项` : "";
      return pass(`${source} 非空（${anchors.length} 项）${detail}`, anchors);
    },
  };
}

/**
 * 最新事件投影中存在无冲突的 confirmed 条目，entry_id 可收窄范围（ADR-0029）。
 * 事件读取失败不回退旧账本，按 block 处理。
 */
export function createLedgerHasConfirmedChecker(options: BuiltinRegistryOptions = {}): Checker {
  const readLedger = async (ctx: CheckerContext): Promise<Ledger> => {
    const session = ctx.session ?? options.session;
    if (session) {
      const events = await session.events.readOrdered();
      if (events.some((event) => event.session_id !== session.req_id)) {
        throw new Error("事件流包含其他 session 的事件，请先修复事件事实");
      }
      const store = session.events as typeof session.events & {
        diagnostics?: () => { notes: Array<{ kind: string }> };
      };
      if (store.diagnostics?.().notes.some((note) => note.kind === "unparsable_line")) {
        throw new Error("事件流包含无法解析的完整行，请先修复事件事实");
      }
      return createReducer().reduce(events);
    }
    return (options.readLedger ?? readLedgerFromDir)(ctx.session_dir);
  };
  return {
    name: "ledger-has-confirmed",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const requested_entry = ctx.payload["entry_id"];
      if (requested_entry !== undefined && (typeof requested_entry !== "string" || requested_entry.trim().length === 0)) {
        return block("entry_id 非法，不能扩大为任意账本条目（fail-closed）");
      }
      let ledger: Ledger;
      try {
        ledger = LedgerSchema.parse(await readLedger(ctx));
      } catch (err) {
        return block(`读取 session 账本失败，fail-closed：${message(err)}`);
      }
      const entryId = typeof ctx.payload["entry_id"] === "string" ? ctx.payload["entry_id"] : null;
      const confirmed = ledger.entries.filter(
        (entry) => entry.status === "confirmed" && !entry.conflict && (entryId === null || entry.entry_id === entryId),
      );
      if (confirmed.length === 0) {
        const scope = entryId === null ? "" : `（限定条目 ${entryId}）`;
        return block(`账本无可用 confirmed 条目${scope}：现有条目 ${ledger.entries.length} 条，冲突条目不放行`);
      }
      const anchors = dedupeAnchors(confirmed.flatMap((entry) => entry.anchors));
      return pass(
        `账本存在 confirmed 条目：${confirmed.map((entry) => entry.entry_id).join(", ")}`,
        anchors.slice(0, 10),
      );
    },
  };
}

/**
 * 投票判定为 confirmed。取值按 `vote_verdict`（约定键）→ `decision` → `vote_record.verdict` 依次取
 * 第一个存在的键；都取不到即 block（fail-closed）。
 */
export function createVoteConfirmedChecker(): Checker {
  return {
    name: "vote-confirmed",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const { value, source } = readVoteVerdict(ctx.payload);
      if (value === "confirmed") {
        return pass(`${source} === "confirmed"`, ctx.anchors);
      }
      return block(`${source} = ${JSON.stringify(value ?? null)}，非 "confirmed"`);
    },
  };
}

function readVoteVerdict(payload: Record<string, unknown>): { value: unknown; source: string } {
  if (payload["vote_verdict"] !== undefined) {
    return { value: payload["vote_verdict"], source: "payload.vote_verdict" };
  }
  if (payload["decision"] !== undefined) {
    return { value: payload["decision"], source: "payload.decision" };
  }
  const record = payload["vote_record"];
  if (typeof record === "object" && record !== null && "verdict" in record) {
    return { value: (record as { verdict?: unknown }).verdict, source: "payload.vote_record.verdict" };
  }
  return { value: undefined, source: "payload.vote_verdict" };
}

// ---------------------------------------------------------------------------
// 参数化内置 checker（ADR-0024：checks[].with → ctx.params；参数非法一律 block）
// ---------------------------------------------------------------------------

/** 参数解析：非法即 fail-closed，不用缺省值猜（ADR-0024 决策 1） */
function parseParams<T>(
  checkerName: string,
  schema: z.ZodType<T>,
  ctx: CheckerContext,
): { ok: true; params: T } | { ok: false; result: GateResult } {
  const parsed = schema.safeParse(ctx.params ?? {});
  if (parsed.success) return { ok: true, params: parsed.data };
  const detail = parsed.error.issues
    .map((issue) => `with.${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("；");
  return { ok: false, result: block(`checker "${checkerName}" 参数非法（fail-closed）：${detail}`) };
}

/** 文件类 checker 的证据锚点：与 run-service 的 nodeAnchors 同一形态 */
function docAnchor(ctx: CheckerContext, path: string): Anchor {
  return { kind: "doc", anchor: `cord/${basename(ctx.session_dir)}/${path}` };
}

const FileExistsParams = z.object({ path: z.string().min(1) });

/** 文件存在：{ path }（session 目录相对路径） */
export function createFileExistsChecker(): Checker {
  return {
    name: "file-exists",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const parsed = parseParams("file-exists", FileExistsParams, ctx);
      if (!parsed.ok) return parsed.result;
      const { path } = parsed.params;
      try {
        const info = await statSessionDocument(ctx.session_dir, path);
        if (info === null) return block(`文件不存在：${path}`);
        return pass(`文件存在：${path}（${info.size} 字节）`, [docAnchor(ctx, path)]);
      } catch (error) {
        return block(`无法验证文件 ${path}（fail-closed）：${message(error)}`);
      }
    },
  };
}

const FileNonemptyParams = z.object({
  path: z.string().min(1),
  min_bytes: z.number().int().min(1).default(1),
});

/** 文件存在且有实质内容：{ path, min_bytes? }（剥掉 HTML 注释与空白后计字节数） */
export function createFileNonemptyChecker(): Checker {
  return {
    name: "file-nonempty",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const parsed = parseParams("file-nonempty", FileNonemptyParams, ctx);
      if (!parsed.ok) return parsed.result;
      const { path, min_bytes: minBytes } = parsed.params;
      let text: string | null;
      try {
        text = await readSessionDocument(ctx.session_dir, path);
      } catch (error) {
        return block(`无法读取文件 ${path}（fail-closed）：${message(error)}`);
      }
      if (text === null) return block(`文件不存在：${path}`);
      const contentBytes = Buffer.byteLength(text.replace(/<!--[\s\S]*?-->/g, "").trim(), "utf8");
      if (contentBytes < minBytes) {
        return block(`文件实质内容不足：${path}（${contentBytes} 字节 < 要求 ${minBytes} 字节）`);
      }
      return pass(`文件非空：${path}（实质内容 ${contentBytes} 字节）`, [docAnchor(ctx, path)]);
    },
  };
}

const DocHasSectionParams = z.object({
  path: z.string().min(1),
  heading: z.string().min(1),
});

/** Markdown 含指定标题：{ path, heading }（# 前缀匹配，大小写不敏感） */
export function createDocHasSectionChecker(): Checker {
  return {
    name: "doc-has-section",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const parsed = parseParams("doc-has-section", DocHasSectionParams, ctx);
      if (!parsed.ok) return parsed.result;
      const { path, heading } = parsed.params;
      let text: string | null;
      try {
        text = await readSessionDocument(ctx.session_dir, path);
      } catch (error) {
        return block(`无法读取文档 ${path}（fail-closed）：${message(error)}`);
      }
      if (text === null) return block(`文档不存在：${path}`);
      const wanted = heading.trim().toLowerCase();
      const found = text
        .split("\n")
        .some((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === wanted);
      if (!found) return block(`文档 ${path} 缺少小节：「${heading}」`);
      return pass(`文档 ${path} 含小节「${heading}」`, [docAnchor(ctx, path)]);
    },
  };
}

const AnchorsMinCountParams = z.object({ min: z.number().int().min(1) });

/** 证据锚点数量下限：{ min }（anchors-present 的参数化泛化；锚点来源约定同 anchors-present） */
export function createAnchorsMinCountChecker(): Checker {
  return {
    name: "anchors-min-count",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const parsed = parseParams("anchors-min-count", AnchorsMinCountParams, ctx);
      if (!parsed.ok) return parsed.result;
      const { min } = parsed.params;
      const fromPayload = ctx.payload["anchors"];
      const raw = Array.isArray(fromPayload) ? fromPayload : ctx.anchors;
      const { anchors, invalid } = parseAnchors(raw);
      if (anchors.length < min) {
        return block(`合法锚点不足：${anchors.length} 个 < 要求 ${min} 个（忽略非法 ${invalid} 项）`);
      }
      return pass(`合法锚点 ${anchors.length} 个 ≥ ${min}`, anchors.slice(0, 10));
    },
  };
}

const EventEmittedParams = z.object({
  type: z.string().min(1),
  /** true 时只认 correlation_id === 当前节点的事件（执行器注入 ctx.node_id） */
  within_node: z.boolean().default(false),
});

async function readEventsForCheck(ctx: CheckerContext): Promise<EventEnvelope[]> {
  if (ctx.session !== undefined) return ctx.session.events.readOrdered();
  const text = await readFile(join(ctx.session_dir, "events.jsonl"), "utf8");
  const events: EventEnvelope[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = EventEnvelopeSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // 单行损坏不阻断整体判定（doctor 负责兜底完整性）
    }
  }
  return events;
}

/** 事件流中出现过某类型事件：{ type, within_node? }（如 agent.task.completed） */
export function createEventEmittedChecker(): Checker {
  return {
    name: "event-emitted",
    async check(ctx: CheckerContext): Promise<GateResult> {
      const parsed = parseParams("event-emitted", EventEmittedParams, ctx);
      if (!parsed.ok) return parsed.result;
      const { type, within_node: withinNode } = parsed.params;
      if (withinNode && ctx.node_id === undefined) {
        return block(`within_node=true 需要执行器注入节点上下文（ctx.node_id 缺失）`);
      }
      if (ctx.workflow_revision !== undefined && ctx.workflow_id === undefined) return block("执行版本缺少 workflow_id，无法验证事件作用域");
      let events: EventEnvelope[];
      try {
        events = await readEventsForCheck(ctx);
      } catch (err) {
        return block(`读取事件流失败，fail-closed：${message(err)}`);
      }
      const hits = events.filter(
        (event) =>
          event.type === type &&
          (ctx.workflow_id === undefined || (!/^(workflow|gate|agent\.task|coordinator\.round)\./.test(event.type) &&
            (typeof event.payload !== "object" || event.payload === null || !("workflow_id" in event.payload))) ||
            matchesWorkflowScope(event.payload, { workflow_id: ctx.workflow_id, workflow_revision: ctx.workflow_revision })) &&
          (!withinNode || event.correlation_id === ctx.node_id),
      );
      if (hits.length === 0) {
        const scope = withinNode ? `（限定节点 ${ctx.node_id}）` : "";
        return block(`事件流中未出现 ${type}${scope}：共 ${events.length} 条事件`);
      }
      const last = hits[hits.length - 1];
      return pass(`事件 ${type} 已出现 ${hits.length} 次（最近 seq=${last?.seq ?? "?"}）`);
    },
  };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

async function readLedgerFromDir(sessionDir: string): Promise<Ledger> {
  const text = await readFile(join(sessionDir, "events.jsonl"), "utf8");
  const events: EventEnvelope[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let event: EventEnvelope;
    try {
      event = EventEnvelopeSchema.parse(JSON.parse(line));
    } catch {
      throw new Error(`事件流第 ${index + 1} 行不符合事件契约`);
    }
    if (event.session_id !== basename(sessionDir)) throw new Error(`事件流第 ${index + 1} 行属于其他 session`);
    events.push(event);
  }
  return createReducer().reduce(events);
}

function pass(reason: string, anchors: Anchor[] = []): GateResult {
  return { result: "pass", anchors, reason, confidence: 1 };
}

function block(reason: string, anchors: Anchor[] = []): GateResult {
  return { result: "block", anchors, reason, confidence: 1 };
}

function parseAnchors(raw: unknown[]): { anchors: Anchor[]; invalid: number } {
  const anchors: Anchor[] = [];
  let invalid = 0;
  for (const item of raw) {
    const parsed = AnchorSchema.safeParse(item);
    if (parsed.success) anchors.push(parsed.data);
    else invalid += 1;
  }
  return { anchors, invalid };
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
