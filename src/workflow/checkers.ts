/**
 * 内置 checker 注册表（ADR-0014 的 L1 档：平台预置、按名引用）。
 *
 * fail-closed 约定：无法判定（注册表无此名由执行器兜底、账本读不到、锚点不合法）一律返回
 * `block`，不放行——「无证据不入账」对门禁结论同样成立。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AnchorSchema,
  LedgerSchema,
  type Anchor,
  type GateResult,
  type Ledger,
  type WorkflowDef,
} from "../core/schema.js";
import type { Checker, CheckerContext, CheckerRegistry, SessionHandle } from "../core/ports.js";

export const BUILTIN_CHECKER_NAMES = ["anchors-present", "ledger-has-confirmed", "vote-confirmed"] as const;
export type BuiltinCheckerName = (typeof BUILTIN_CHECKER_NAMES)[number];

export interface BuiltinRegistryOptions {
  /** 兜底绑定的 session（执行器已通过 `ctx.session` 给出，通常不需要；跨进程调用者才用得上） */
  session?: SessionHandle;
  /** 未绑定 session 且 `ctx.session` 缺失时的账本读取端口；默认读 `<session_dir>/ledger.yaml` */
  readLedger?: (session_dir: string) => Promise<Ledger>;
}

export function createBuiltinRegistry(options: BuiltinRegistryOptions = {}): CheckerRegistry {
  const checkers = new Map<string, Checker>();
  for (const checker of [
    createAnchorsPresentChecker(),
    createLedgerHasConfirmedChecker(options),
    createVoteConfirmedChecker(),
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
 * 账本存在 confirmed 条目。`payload.entry_id` 存在时收窄为「该条目为 confirmed」。
 * 账本读取失败 → block（fail-closed）。
 */
export function createLedgerHasConfirmedChecker(options: BuiltinRegistryOptions = {}): Checker {
  const readLedger = async (ctx: CheckerContext): Promise<Ledger> => {
    const session = ctx.session ?? options.session;
    if (session) return session.readLedger();
    return (options.readLedger ?? readLedgerFromDir)(ctx.session_dir);
  };
  return {
    name: "ledger-has-confirmed",
    async check(ctx: CheckerContext): Promise<GateResult> {
      let ledger: Ledger;
      try {
        ledger = await readLedger(ctx);
      } catch (err) {
        return block(`读取 session 账本失败，fail-closed：${message(err)}`);
      }
      const entryId = typeof ctx.payload["entry_id"] === "string" ? ctx.payload["entry_id"] : null;
      const confirmed = ledger.entries.filter(
        (entry) => entry.status === "confirmed" && (entryId === null || entry.entry_id === entryId),
      );
      if (confirmed.length === 0) {
        const scope = entryId === null ? "" : `（限定条目 ${entryId}）`;
        return block(`账本无 confirmed 条目${scope}：现有条目 ${ledger.entries.length} 条`);
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
// 内部
// ---------------------------------------------------------------------------

async function readLedgerFromDir(sessionDir: string): Promise<Ledger> {
  const text = await readFile(join(sessionDir, "ledger.yaml"), "utf8");
  return LedgerSchema.parse(parseYaml(text));
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
