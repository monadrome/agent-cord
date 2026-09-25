#!/usr/bin/env node
/**
 * cord CLI（ADR-0016 npm 分发 + 启动自检；ADR-0010 布局与 init/doctor 职责；ADR-0012 CLI 也是适配器）。
 * 本文件只做薄编排：把命令转成对 core / workflow / voting 公共 API 的调用，不重复其逻辑。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildEventDraft } from "./adapters/cli.js";
import type { DoctorReport } from "./core/ports.js";
import { EventEnvelopeSchema, type Anchor, type EventEnvelope } from "./core/schema.js";
import { initSession, openSession } from "./core/session.js";
import { createVoteExecutor } from "./voting/executor.js";
import { MockProvider } from "./voting/provider/mock.js";
import { createBuiltinRegistry } from "./workflow/checkers.js";

const require_ = createRequire(import.meta.url);

export const CORD_DIR = "cord";
export const CORD_TOML = "cord.toml";
export const LAYOUT_VERSION = 1;
export const EVENT_SCHEMA_VERSION = "1";
export const CORD_API_VERSION = "agent-cord.dev/v1alpha1";
export const MERGE_DRIVER_NAME = "cord-event-log";
export const EVENT_LOG_PATHSPEC = "cord/**/events.jsonl";
export const GITATTRIBUTES_LINE = `${EVENT_LOG_PATHSPEC} merge=${MERGE_DRIVER_NAME}`;
export const MIN_NODE_VERSION = "22.5.0";

const KNOWLEDGE_DIR = "knowledge";
const EVENTS_FILE = "events.jsonl";
const LEDGER_FILE = "ledger.yaml";
const DEMO_REQ_ID = "REQ-DEMO";
const DEMO_ENTRY_ID = "C-1";
const DEMO_ANCHORS_GATE = "anchors-present";
const DEMO_VOTE_GATE = "vote-confirmed";

// ---------------------------------------------------------------------------
// cord init（ADR-0010 决策 4 布局；注意点 3 版本；注意点 11 merge driver 注册）
// ---------------------------------------------------------------------------

export interface InitResult {
  root: string;
  cord_root: string;
  created: string[];
  changed: string[];
  skipped: string[];
  merge_driver_commands: string[];
}

export function renderCordToml(): string {
  return [
    "# cord SSOT 根目录配置（ADR-0010 决策 4/5、docs/07）",
    "# 布局与事件 schema 版本由 cord doctor / cord upgrade 迁移，人不需要手工搬文件。",
    `layout_version = ${LAYOUT_VERSION}`,
    `event_schema_version = "${EVENT_SCHEMA_VERSION}"`,
    `apiVersion = "${CORD_API_VERSION}"`,
    "",
    "[index]",
    "# 派生索引：可删除、可再生（ADR-0010 注意点 8），不进 SSOT 的权威层。",
    'kind = "sqlite-fts5"',
    "derived = true",
    `path = "${CORD_DIR}/.index"`,
    'rebuild_command = "cord index --rebuild"',
    "",
    "[documents]",
    "# 文档版本语义（ADR-0010 决策 5）：living = 现状即真相，历史在事件流。",
    'prd = "living"',
    'adr = "living"',
    'plan = "living"',
    'findings = "living"',
    "",
  ].join("\n");
}

/** 自定义 merge driver 定义在 .git/config，不随仓库分发（ADR-0010 注意点 11） */
export function mergeDriverCommands(driver_path = "<cord-merge-driver.js>"): string[] {
  return [
    `git config merge.${MERGE_DRIVER_NAME}.name "cord events.jsonl union merge (dedupe by event_id, sort by (seq, event_id))"`,
    `git config merge.${MERGE_DRIVER_NAME}.driver "node ${driver_path} %O %A %B"`,
  ];
}

export async function runInit(root: string = process.cwd()): Promise<InitResult> {
  const cord_root = path.join(root, CORD_DIR);
  const created: string[] = [];
  const changed: string[] = [];
  const skipped: string[] = [];

  for (const [label, dir] of [
    [CORD_DIR, cord_root],
    [`${CORD_DIR}/${KNOWLEDGE_DIR}`, path.join(cord_root, KNOWLEDGE_DIR)],
  ] as const) {
    if (existsSync(dir)) {
      skipped.push(label);
      continue;
    }
    await mkdir(dir, { recursive: true });
    created.push(label);
  }

  const toml_path = path.join(cord_root, CORD_TOML);
  if (existsSync(toml_path)) {
    skipped.push(`${CORD_DIR}/${CORD_TOML}`);
  } else {
    await writeFile(toml_path, renderCordToml(), "utf8");
    created.push(`${CORD_DIR}/${CORD_TOML}`);
  }

  const attr_path = path.join(root, ".gitattributes");
  const attributes = existsSync(attr_path) ? await readFile(attr_path, "utf8") : null;
  if (attributes !== null && hasGitattributesEntry(attributes)) {
    skipped.push(".gitattributes");
  } else {
    const header = attributes ?? "# cord：事件流合并走自定义 driver（ADR-0010 注意点 1/11）\n";
    const base = header.length === 0 || header.endsWith("\n") ? header : `${header}\n`;
    await writeFile(attr_path, `${base}${GITATTRIBUTES_LINE}\n`, "utf8");
    (attributes === null ? created : changed).push(".gitattributes");
  }

  return { root, cord_root, created, changed, skipped, merge_driver_commands: mergeDriverCommands() };
}

export function hasGitattributesEntry(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === GITATTRIBUTES_LINE);
}

// ---------------------------------------------------------------------------
// cord doctor（ADR-0010 注意点 11 driver 自检；ADR-0020 注意点 5 三项校验由 core 的 doctor 负责）
// ---------------------------------------------------------------------------

export interface EventLogValidation {
  ok: boolean;
  line_count: number;
  events: EventEnvelope[];
  error: string | null;
}

/** 纯函数：逐行 JSON 解析 + EventEnvelope v1 校验（损坏行必须可见） */
export function parseEventLog(text: string): EventLogValidation {
  const events: EventEnvelope[] = [];
  let line_count = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    line_count += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        ok: false,
        line_count,
        events,
        error: `第 ${index + 1} 行不是合法 JSON：${errorMessage(error)}`,
      };
    }
    const envelope = EventEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      const issue = envelope.error.issues[0];
      const where = issue === undefined ? "" : ` (${issue.path.join(".") || "root"}: ${issue.message})`;
      return {
        ok: false,
        line_count,
        events,
        error: `第 ${index + 1} 行不符合 EventEnvelope v1：${where}`,
      };
    }
    events.push(envelope.data);
  }
  return { ok: true, line_count, events, error: null };
}

export interface CliDoctorOptions {
  fix?: boolean;
}

export interface CliDoctorReport extends DoctorReport {
  sessions: string[];
  fixed: string[];
}

export async function runDoctor(
  root: string = process.cwd(),
  options: CliDoctorOptions = {},
): Promise<CliDoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const fixed: string[] = [];
  const cord_root = path.join(root, CORD_DIR);

  if (!existsSync(cord_root)) {
    return {
      ok: false,
      checks: [{ name: "layout", ok: false, detail: `${CORD_DIR}/ 不存在：先运行 cord init` }],
      sessions: [],
      fixed,
    };
  }
  checks.push({ name: "layout", ok: true, detail: cord_root });
  checks.push(await checkCordToml(root));
  checks.push(await checkMergeDriver(root));

  const sessions = await listSessionIds(cord_root);
  for (const req_id of sessions) {
    checks.push(...(await checkSession(cord_root, req_id, options, fixed)));
  }

  return { ok: checks.every((check) => check.ok), checks, sessions, fixed };
}

async function checkSession(
  cord_root: string,
  req_id: string,
  options: CliDoctorOptions,
  fixed: string[],
): Promise<DoctorReport["checks"]> {
  const prefix = `session(${req_id})`;
  const log_path = path.join(cord_root, req_id, EVENTS_FILE);
  if (!existsSync(log_path)) {
    return [{ name: `${prefix}.events`, ok: true, detail: "无 events.jsonl：尚未写入事件" }];
  }

  const validation = parseEventLog(await readFile(log_path, "utf8"));
  if (!validation.ok || validation.error !== null) {
    return [{ name: `${prefix}.events`, ok: false, detail: validation.error ?? "事件流解析失败" }];
  }
  const checks: DoctorReport["checks"] = [
    { name: `${prefix}.events`, ok: true, detail: `${validation.line_count} 条事件可解析` },
  ];

  try {
    const session = await openSession(cord_root, req_id);
    let report = await session.doctor();
    if (options.fix === true && !report.ok && needsLedgerRebuild(report)) {
      await session.rebuildLedger();
      report = await session.doctor();
      fixed.push(req_id);
    }
    checks.push(...report.checks.map((check) => ({ ...check, name: `${prefix}.${check.name}` })));
  } catch (error) {
    checks.push({ name: `${prefix}.core`, ok: false, detail: `core session 失败：${errorMessage(error)}` });
  }
  return checks;
}

/** 漂移类失败才重建：账本缺失 / 重放不一致 / 哈希不匹配（ADR-0020 决策 4） */
export function needsLedgerRebuild(report: DoctorReport): boolean {
  return report.checks.some((check) => !check.ok && /ledger|replay|reduce|drift|hash/i.test(check.name));
}

async function listSessionIds(cord_root: string): Promise<string[]> {
  const entries = await readdir(cord_root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== KNOWLEDGE_DIR && !name.startsWith("."))
    .sort();
}

async function checkCordToml(root: string): Promise<DoctorReport["checks"][number]> {
  const name = `${CORD_DIR}/${CORD_TOML}`;
  const file = path.join(root, CORD_DIR, CORD_TOML);
  if (!existsSync(file)) return { name, ok: false, detail: "缺失：运行 cord init" };
  const content = await readFile(file, "utf8");
  const layout = /^layout_version\s*=\s*(\d+)/m.exec(content)?.[1];
  const schema = /^event_schema_version\s*=\s*"([^"]+)"/m.exec(content)?.[1];
  if (layout === undefined || schema === undefined) {
    return { name, ok: false, detail: "缺少 layout_version / event_schema_version（运行 cord init 或 cord upgrade）" };
  }
  if (Number.parseInt(layout, 10) !== LAYOUT_VERSION) {
    return { name, ok: false, detail: `layout_version=${layout}，本 CLI 支持 ${LAYOUT_VERSION}：运行 cord upgrade` };
  }
  if (schema !== EVENT_SCHEMA_VERSION) {
    return { name, ok: false, detail: `event_schema_version=${schema}，本 CLI 支持 ${EVENT_SCHEMA_VERSION}` };
  }
  return { name, ok: true, detail: `layout_version=${layout} event_schema_version=${schema}` };
}

/** ADR-0010 注意点 11：新 clone 会静默退回文本合并，必须可检测 */
async function checkMergeDriver(root: string): Promise<DoctorReport["checks"][number]> {
  const name = "merge_driver";
  const attr_path = path.join(root, ".gitattributes");
  const registered = existsSync(attr_path) && hasGitattributesEntry(await readFile(attr_path, "utf8"));
  if (!existsSync(path.join(root, ".git"))) {
    return {
      name,
      ok: true,
      detail: registered ? ".gitattributes 已注册；非 git 仓库，跳过 .git/config 检查" : "非 git 仓库：跳过",
    };
  }
  const config_path = path.join(root, ".git", "config");
  const driver = findMergeDriver(existsSync(config_path) ? await readFile(config_path, "utf8") : null);
  if (registered && driver !== null) {
    return { name, ok: true, detail: `driver 已挂上：${driver}` };
  }
  const missing = [
    registered ? null : `.gitattributes 缺少 "${GITATTRIBUTES_LINE}"`,
    driver === null ? `.git/config 缺少 merge.${MERGE_DRIVER_NAME}.driver` : null,
  ].filter((item): item is string => item !== null);
  return {
    name,
    ok: false,
    detail: `${missing.join("；")}。安装：${mergeDriverCommands().join(" && ")}`,
  };
}

/** 极简 .git/config 解析：找 [merge "cord-event-log"] 段内的 driver */
export function findMergeDriver(config: string | null): string | null {
  if (config === null) return null;
  let in_section = false;
  let driver: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      in_section = /^\[merge\s+"?cord-event-log"?\]$/i.test(line);
      continue;
    }
    if (!in_section) continue;
    const matched = /^driver\s*=\s*(.+)$/.exec(line);
    if (matched?.[1] !== undefined) driver = matched[1].trim();
  }
  return driver;
}

// ---------------------------------------------------------------------------
// cord new / cord events
// ---------------------------------------------------------------------------

export async function runNew(root: string, req_id: string): Promise<{ req_id: string; dir: string }> {
  const id = req_id.trim();
  if (id.length === 0) throw new Error("需要 req-id：cord new <req-id>");
  const session = await initSession(path.join(root, CORD_DIR), id);
  return { req_id: session.req_id, dir: session.dir };
}

export interface EventsResult {
  req_id: string;
  count: number;
  lines: string[];
  /** 事件流中有读不出来的行时必须可见（不静默当空流） */
  warning: string | null;
}

export async function runEvents(root: string, req_id: string): Promise<EventsResult> {
  const id = req_id.trim();
  if (id.length === 0) throw new Error("需要 req-id：cord events <req-id>");
  const cord_root = path.join(root, CORD_DIR);
  const session = await openSession(cord_root, id);
  const events = await session.events.readOrdered();

  const validation = parseEventLog(await readFile(path.join(cord_root, id, EVENTS_FILE), "utf8"));
  const warning = validation.ok
    ? null
    : `${id} 的 events.jsonl 有无法解析的行（${validation.error}），以下仅列出可读事件；运行 cord doctor 查看完整诊断`;

  return { req_id: id, count: events.length, lines: events.map(renderEventLine), warning };
}

export function renderEventLine(event: EventEnvelope): string {
  const head = [
    String(event.seq).padStart(4, "0"),
    event.type.padEnd(26),
    `${event.actor.kind}:${event.actor.id}`.padEnd(22),
    event.timestamp,
    event.event_id,
  ].join("  ");
  return `${head}\n     ${truncate(JSON.stringify(event.payload) ?? "null", 160)}`;
}

// ---------------------------------------------------------------------------
// cord demo —— M2 最小闭环（纯离线：只用 MockProvider，无网络调用）
// ---------------------------------------------------------------------------

export interface DemoStep {
  step: string;
  detail: string;
}

export interface DemoSummary {
  root: string;
  session_id: string;
  session_dir: string;
  entry_id: string;
  vote_id: string;
  verdict: string;
  raw_agreement: number;
  anchor_overlap: number;
  ballots: number;
  gates: Array<{ gate_id: string; result: string; action: string }>;
  ledger_entries: number;
  ledger_consistent: boolean;
  doctor_ok: boolean;
  steps: DemoStep[];
}

const DEMO_TARGET_TS = [
  "export interface DemoTarget {",
  "  id: string;",
  "}",
  "",
  'export const demoTarget: DemoTarget = { id: "demo" };',
  "",
  "export function resolveDemoTarget(): string {",
  "  return demoTarget.id;",
  "}",
  "",
].join("\n");

const DEMO_SPEC_MD = [
  "# Demo 验收规则",
  "",
  "## demo-acceptance",
  "",
  "锚点存在且 k=2 盲评一致时，条目晋升 confirmed。",
  "",
].join("\n");

const DEMO_TARGET_ANCHOR = "src/demo/target.ts#resolveDemoTarget";
const DEMO_SPEC_ANCHOR = "docs/demo-acceptance.md#demo-acceptance";

export async function runDemo(options: { keep?: boolean } = {}): Promise<DemoSummary> {
  const root = await mkdtemp(path.join(tmpdir(), "cord-demo-"));
  const steps: DemoStep[] = [];
  try {
    const summary = await runDemoIn(root, steps);
    if (options.keep !== true) await rm(root, { recursive: true, force: true });
    return { ...summary, root, steps };
  } catch (error) {
    throw new Error(`${errorMessage(error)}（临时目录保留供排查：${root}）`);
  }
}

async function runDemoIn(root: string, steps: DemoStep[]): Promise<Omit<DemoSummary, "root" | "steps">> {
  const init = await runInit(root);
  steps.push({
    step: "init",
    detail: `${CORD_DIR}/ 就绪（新建 ${init.created.length} 项，复用 ${init.skipped.length} 项）`,
  });

  const session = await initSession(path.join(root, CORD_DIR), DEMO_REQ_ID);
  steps.push({ step: "new", detail: `${DEMO_REQ_ID} @ ${path.relative(root, session.dir)}` });

  const target_path = path.join(root, "src", "demo", "target.ts");
  const spec_path = path.join(root, "docs", "demo-acceptance.md");
  await mkdir(path.dirname(target_path), { recursive: true });
  await mkdir(path.dirname(spec_path), { recursive: true });
  await writeFile(target_path, DEMO_TARGET_TS, "utf8");
  await writeFile(spec_path, DEMO_SPEC_MD, "utf8");
  steps.push({
    step: "fixtures",
    detail: "写入真实存在的锚点目标（src/demo/target.ts、docs/demo-acceptance.md）",
  });

  const anchors: Anchor[] = [
    {
      kind: "code",
      anchor: DEMO_TARGET_ANCHOR,
      snapshot: { content_hash: `sha256:${createHash("sha256").update(DEMO_TARGET_TS).digest("hex")}` },
      line_hint: "src/demo/target.ts:7",
    },
  ];
  const title = "M2 最小闭环：锚点存在 + k=2 盲评一致即晋升 confirmed";
  const proposed = await session.events.append(
    buildEventDraft({
      session_id: DEMO_REQ_ID,
      type: "ledger.entry.proposed",
      actor: { kind: "agent", id: "explore-agent" },
      payload: {
        entry_id: DEMO_ENTRY_ID,
        title,
        statement: "锚点存在（anchors-present）且 2/2 盲评一致（vote-confirmed）时，条目由 provisional 晋升 confirmed。",
        status: "provisional",
        anchors,
      },
    }),
  );
  steps.push({ step: "propose", detail: `${DEMO_ENTRY_ID} provisional（event ${proposed.event_id}）` });

  const verifier = createAnchorVerifier(root);
  const record = await createVoteExecutor().run({
    decision_point: {
      id: "DP-DEMO-1",
      question: `是否确认「${title}」？`,
      options: ["confirm", "reject"],
      machine_verifiable: true,
      context_pack: `条目 ${DEMO_ENTRY_ID} 的证据锚点：${DEMO_TARGET_ANCHOR}（只读快照，自行取证）`,
    },
    voters: [
      {
        agent_id: "voter-a",
        model_id: "mock-a-v1",
        adapter: new MockProvider({
          provider: "mock-a",
          responses: [
            {
              parsed_json: {
                conclusion: "confirm",
                anchors,
                confidence: 0.9,
                reason: "锚点文件真实存在且符号可定位。",
              },
            },
          ],
        }),
      },
      {
        agent_id: "voter-b",
        model_id: "mock-b-v1",
        adapter: new MockProvider({
          provider: "mock-b",
          responses: [
            {
              parsed_json: {
                conclusion: "confirm",
                anchors: [{ kind: "doc", anchor: DEMO_SPEC_ANCHOR }],
                confidence: 0.85,
                reason: "验收规则文档中的 demo-acceptance 段落与结论一致。",
              },
            },
          ],
        }),
      },
    ],
    verify_anchor: verifier,
  });
  const vote_event = await session.events.append(
    buildEventDraft({
      session_id: DEMO_REQ_ID,
      type: "vote.completed",
      actor: { kind: "system", id: "voting" },
      correlation_id: proposed.event_id,
      source_adapter: "system",
      payload: {
        entry_id: DEMO_ENTRY_ID,
        vote_id: record.vote_id,
        decision: record.verdict,
        anchor_overlap: record.stats.anchor_overlap,
        vote_record: record,
      },
    }),
  );
  steps.push({
    step: "vote",
    detail: `${record.vote_id} k=${record.k} verdict=${record.verdict} 一致率=${record.stats.raw_agreement} 锚点重合=${record.stats.anchor_overlap}`,
  });

  const registry = createBuiltinRegistry();
  const gates: DemoSummary["gates"] = [];
  for (const gate_id of [DEMO_ANCHORS_GATE, DEMO_VOTE_GATE]) {
    const checker = registry.get(gate_id);
    if (checker === undefined) throw new Error(`内置 checker 缺失：${gate_id}`);
    const result = await checker.check({
      session_dir: session.dir,
      session,
      anchors,
      payload: {
        entry_id: DEMO_ENTRY_ID,
        anchors,
        vote_id: record.vote_id,
        vote_verdict: record.verdict,
        vote_record: record,
        machine_verifiable: true,
      },
    });
    const action = result.result === "pass" ? "continue" : result.result === "block" ? "stop" : "escalate";
    await session.events.append(
      buildEventDraft({
        session_id: DEMO_REQ_ID,
        type: "gate.resolved",
        actor: { kind: "system", id: "gate" },
        correlation_id: vote_event.event_id,
        source_adapter: "system",
        payload: {
          gate_id,
          entry_ids: [DEMO_ENTRY_ID],
          result: result.result,
          action,
          reason: result.reason,
        },
      }),
    );
    gates.push({ gate_id, result: result.result, action });
    if (result.result !== "pass") {
      throw new Error(`门禁未放行：${gate_id}=${result.result}（${result.reason}）`);
    }
  }
  if (record.verdict !== "confirmed") {
    throw new Error(`投票判定不是 confirmed：${record.verdict}（2/2 一致 + 锚点可机验 + 无重合才放行）`);
  }
  steps.push({ step: "gate", detail: gates.map((gate) => `${gate.gate_id}=${gate.result}`).join(" ") });

  await session.events.append(
    buildEventDraft({
      session_id: DEMO_REQ_ID,
      type: "ledger.entry.confirmed",
      actor: { kind: "system", id: "consensus" },
      correlation_id: vote_event.event_id,
      source_adapter: "system",
      payload: {
        entry_id: DEMO_ENTRY_ID,
        confidence_source: "vote_agreement",
        vote_record_id: record.vote_id,
      },
    }),
  );

  const rebuilt = await session.rebuildLedger();
  const current = await session.readLedger();
  const ledger_consistent =
    rebuilt.output_hash === current.output_hash &&
    rebuilt.entries.length === current.entries.length &&
    current.entries.length > 0 &&
    current.entries.every((entry) => entry.status === "confirmed" && !entry.conflict);
  if (!ledger_consistent) {
    throw new Error(
      `events.jsonl 与 ledger.yaml 不一致：重建 ${rebuilt.entries.length} 条 / 磁盘 ${current.entries.length} 条`,
    );
  }
  steps.push({
    step: "ledger",
    detail: `条目 ${current.entries.length} 条 confirmed，output_hash 与事件流重放一致（${truncate(current.output_hash, 16)}）`,
  });

  const doctor = await session.doctor();
  if (!doctor.ok) {
    const failed = doctor.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    throw new Error(`doctor 未全绿：${failed}`);
  }
  steps.push({ step: "doctor", detail: `${doctor.checks.length} 项检查全绿` });

  return {
    session_id: DEMO_REQ_ID,
    session_dir: session.dir,
    entry_id: DEMO_ENTRY_ID,
    vote_id: record.vote_id,
    verdict: record.verdict,
    raw_agreement: record.stats.raw_agreement,
    anchor_overlap: record.stats.anchor_overlap,
    ballots: record.ballots.length,
    gates,
    ledger_entries: current.entries.length,
    ledger_consistent,
    doctor_ok: doctor.ok,
  };
}

/** 锚点机验器：锚点必须指向真实存在的文件（带符号时还须在文件中出现） */
export function createAnchorVerifier(root: string): (anchor: Anchor) => Promise<boolean> {
  const base = path.resolve(root);
  return async (anchor: Anchor): Promise<boolean> => {
    const { file_path, symbol } = splitAnchor(anchor.anchor);
    if (file_path.length === 0) return false;
    const resolved = path.resolve(base, file_path);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return false;
    let info;
    try {
      info = await stat(resolved);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;
    if (symbol === null) return true;
    const content = await readFile(resolved, "utf8").catch(() => null);
    return content !== null && content.includes(symbol);
  };
}

export function splitAnchor(anchor: string): { file_path: string; symbol: string | null } {
  const index = anchor.indexOf("#");
  if (index < 0) return { file_path: anchor.trim(), symbol: null };
  return { file_path: anchor.slice(0, index).trim(), symbol: anchor.slice(index + 1).trim() };
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

export const HELP = `cord —— 多 agent 共识协作基座 CLI

用法：
  cord init                 在当前目录初始化 cord/ SSOT 根（幂等）
  cord new <req-id>         新建一个需求 session（cord/<req-id>/）
  cord doctor [--fix]       校验布局 / merge driver / 事件流 / 账本漂移（--fix 重建漂移账本）
  cord demo                 在临时目录跑 M2 最小闭环（纯离线）
  cord events <req-id>      按因果序打印事件流摘要
  cord help                 显示本帮助
`;

export function checkNodeVersion(
  version: string = process.versions.node,
  required: string = MIN_NODE_VERSION,
): { ok: boolean; detail: string } {
  const current = parseVersion(version);
  const want = parseVersion(required);
  const ok = current.major > want.major || (current.major === want.major && current.minor >= want.minor);
  return { ok, detail: `node v${version}（engines.node >= ${required}）` };
}

function parseVersion(version: string): { major: number; minor: number } {
  const parts = version.replace(/^v/, "").split(".");
  return { major: Number.parseInt(parts[0] ?? "0", 10) || 0, minor: Number.parseInt(parts[1] ?? "0", 10) || 0 };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const engines = checkNodeVersion();
  if (!engines.ok) {
    process.stderr.write(`cord: 需要更高版本的 Node —— ${engines.detail}\n`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        fix: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    process.stderr.write(`cord: ${errorMessage(error)}\n\n${HELP}`);
    return 2;
  }

  if (parsed.values.version === true) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const command = parsed.positionals[0] ?? (parsed.values.help === true ? "help" : undefined);
  const cwd = process.cwd();

  switch (command) {
    case "init": {
      printInit(await runInit(cwd));
      return 0;
    }
    case "new": {
      const req_id = parsed.positionals[1];
      if (req_id === undefined) throw new Error("需要 req-id：cord new <req-id>");
      const created = await runNew(cwd, req_id);
      process.stdout.write(`cord new: ${created.req_id} → ${created.dir}\n`);
      return 0;
    }
    case "doctor": {
      const report = await runDoctor(cwd, { fix: parsed.values.fix === true });
      for (const check of report.checks) {
        process.stdout.write(`  [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}\n`);
      }
      if (report.fixed.length > 0) process.stdout.write(`  已重建 ledger.yaml：${report.fixed.join(", ")}\n`);
      process.stdout.write(`cord doctor: ${report.ok ? "全绿" : "存在失败项"}\n`);
      return report.ok ? 0 : 1;
    }
    case "demo": {
      printDemo(await runDemo());
      return 0;
    }
    case "events": {
      const req_id = parsed.positionals[1];
      if (req_id === undefined) throw new Error("需要 req-id：cord events <req-id>");
      const { count, lines, warning } = await runEvents(cwd, req_id);
      if (warning !== null) process.stderr.write(`cord: ${warning}\n`);
      if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`cord events: ${req_id} 共 ${count} 条（因果序）\n`);
      return 0;
    }
    case "help":
    case undefined: {
      process.stdout.write(HELP);
      return 0;
    }
    default: {
      process.stderr.write(`cord: 未知命令 ${command}\n\n${HELP}`);
      return 2;
    }
  }
}

function printInit(result: InitResult): void {
  process.stdout.write(`cord init: ${result.cord_root}\n`);
  if (result.created.length > 0) process.stdout.write(`  新建: ${result.created.join(", ")}\n`);
  if (result.changed.length > 0) process.stdout.write(`  更新: ${result.changed.join(", ")}\n`);
  if (result.skipped.length > 0) process.stdout.write(`  已存在: ${result.skipped.join(", ")}\n`);
  process.stdout.write(
    [
      "自定义 merge driver 定义在 .git/config，不随仓库分发（ADR-0010 注意点 11），每个新 clone 需执行：",
      ...result.merge_driver_commands.map((command) => `  ${command}`),
      "  自检：cord doctor（检测当前 clone 是否已挂上 driver）",
      "",
    ].join("\n"),
  );
}

function printDemo(summary: DemoSummary): void {
  const lines = [`cord demo · M2 最小闭环（临时目录 ${summary.root}）`, ""];
  summary.steps.forEach((step, index) => {
    lines.push(`  ${String(index + 1).padStart(2, " ")}. ${step.step.padEnd(9)} ${step.detail}`);
  });
  lines.push(
    "",
    `投票 ${summary.vote_id}：k=${summary.ballots} verdict=${summary.verdict} 一致率=${summary.raw_agreement} 锚点重合=${summary.anchor_overlap}`,
    `门禁：${summary.gates.map((gate) => `${gate.gate_id}=${gate.result}`).join(" ")}`,
    `账本：${summary.ledger_entries} 条条目，与事件流重放一致=${summary.ledger_consistent ? "是" : "否"}；doctor=${summary.doctor_ok ? "全绿" : "有失败"}`,
    "",
  );
  process.stdout.write(lines.join("\n"));
}

function packageVersion(): string {
  try {
    const pkg = require_("../package.json") as { version?: string };
    return `agent-cord ${pkg.version ?? "0.0.0"}`;
  } catch {
    return "agent-cord 0.0.0";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  if (error === undefined || error === null) return "未知错误";
  return String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`cord: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
