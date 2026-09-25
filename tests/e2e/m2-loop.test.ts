/**
 * M2 集成收口（e2e）：全部用真实实现，跑在临时目录里。
 *
 * 链路：cli.init → core.initSession → core.jsonl 事件流 → voting（MockProvider k=2，锚点机验真文件）
 *      → workflow 薄执行器 + 内置 gate（anchors-present / vote-confirmed / ledger-has-confirmed）
 *      → core.reducer 重建 ledger.yaml → core.doctor + cli.doctor 全绿。
 *
 * 第二个用例模拟「执行中途被杀」：事件存储抛错后重新 run，已完成节点不得重复产生事件。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCliMessageDraft, buildEventDraft, normalizeCliInput } from "../../src/adapters/cli.js";
import { createAnchorVerifier, runDoctor, runInit } from "../../src/cli.js";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  initSession,
  openSession,
  type Anchor,
  type EventDraft,
  type EventEnvelope,
  type EventType,
  type SessionHandle,
} from "../../src/core/index.js";
import type { HumanGate } from "../../src/core/ports.js";
import { createVoteExecutor, MockProvider } from "../../src/voting/index.js";
import { createExecutor, parseWorkflow } from "../../src/workflow/index.js";

const REQ_ID = "REQ-E2E-1";
const KILL_REQ_ID = "REQ-E2E-KILL";
const ENTRY_ID = "C-1";

const CODE_ANCHOR: Anchor = { kind: "code", anchor: "src/e2e/target.ts#resolveE2ETarget" };
const DOC_ANCHOR: Anchor = { kind: "doc", anchor: "docs/e2e-acceptance.md#e2e-acceptance" };

const TARGET_TS = [
  "export interface E2ETarget {",
  "  id: string;",
  "}",
  "",
  'export const e2eTarget: E2ETarget = { id: "e2e" };',
  "",
  "export function resolveE2ETarget(): string {",
  "  return e2eTarget.id;",
  "}",
  "",
].join("\n");

const SPEC_MD = ["# E2E 验收规则", "", "## e2e-acceptance", "", "锚点存在且 k=2 盲评一致时晋升 confirmed。", ""].join(
  "\n",
);

/** 门禁在这两个用例里都不该等人工：真等到了就是用例前提被破坏，让它显式失败。 */
const NO_HUMAN: HumanGate = {
  async ask() {
    throw new Error("用例不期待等待人工裁决");
  },
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cord-e2e-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function writeFixtures(): Promise<void> {
  const target = path.join(root, "src", "e2e", "target.ts");
  const spec = path.join(root, "docs", "e2e-acceptance.md");
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(path.dirname(spec), { recursive: true });
  await writeFile(target, TARGET_TS, "utf8");
  await writeFile(spec, SPEC_MD, "utf8");
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function ofType(events: readonly EventEnvelope[], type: string): EventEnvelope[] {
  return events.filter((event) => event.type === type);
}

function payloadOf(event: EventEnvelope): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** 节点维度的 entered / exited 计数 */
function nodeCounts(events: readonly EventEnvelope[], node_id: string, type: string): number {
  return ofType(events, type).filter((event) => payloadOf(event)["node_id"] === node_id).length;
}

function gateResults(events: readonly EventEnvelope[], gate_id: string): string[] {
  return ofType(events, "gate.resolved")
    .filter((event) => payloadOf(event)["gate_id"] === gate_id)
    .map((event) => String(payloadOf(event)["result"]));
}

/** 所有已固化 payload schema 的事件都必须真的符合契约（schema 与写入者不能各说各话） */
async function payloadSchemaFailures(session: SessionHandle): Promise<string[]> {
  const failures: string[] = [];
  for (const event of await session.events.readAll()) {
    const schema = EVENT_PAYLOAD_SCHEMAS[event.type as EventType];
    if (schema === undefined) continue;
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      failures.push(`${event.type}: ${issues}`);
    }
  }
  return failures;
}

/** 崩溃注入：第 limit+1 次 append 直接抛错（模拟进程被杀，已落盘的事件保留） */
function sessionFailingAfterAppend(session: SessionHandle, limit: number): SessionHandle {
  let appended = 0;
  return {
    ...session,
    events: {
      async append(draft: EventDraft): Promise<EventEnvelope> {
        if (appended >= limit) throw new Error("模拟进程被杀：事件存储不可用");
        appended += 1;
        return session.events.append(draft);
      },
      readAll: () => session.events.readAll(),
      readOrdered: () => session.events.readOrdered(),
      subscribe: (handler) => session.events.subscribe(handler),
    },
  };
}

const E2E_WORKFLOW_YAML = `
apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata:
  id: wf-e2e
  name: M2 闭环
spec:
  nodes:
    - id: review
      artifact: findings.md
      gates:
        - id: gate-anchors
          role: { initiators: [], approvers: [] }
          attach: { node: review, when: pre }
          checks: [{ ref: anchors-present }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: [session_event]
        - id: gate-vote
          role: { initiators: [], approvers: [] }
          attach: { node: review, when: post }
          checks: [{ ref: vote-confirmed }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: [session_event]
    - id: confirm
      depends_on: [review]
      artifact: ledger.yaml
      gates:
        - id: gate-ledger
          role: { initiators: [], approvers: [] }
          attach: { node: confirm, when: post }
          checks: [{ ref: ledger-has-confirmed }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: [consensus_ledger]
`;

const KILL_WORKFLOW_YAML = `
apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata:
  id: wf-kill
spec:
  nodes:
    - id: a
      gates:
        - id: gate-a
          role: { initiators: [], approvers: [] }
          attach: { node: a, when: post }
          checks: [{ ref: anchors-present }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: [session_event]
    - id: b
      depends_on: [a]
      gates:
        - id: gate-b
          role: { initiators: [], approvers: [] }
          attach: { node: b, when: post }
          checks: [{ ref: anchors-present }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: [session_event]
`;

// ---------------------------------------------------------------------------

describe("M2 闭环：proposal → 盲评 → gate → confirmed → doctor", () => {
  it("initSession 起步，k=2 盲评 + 内置 gate 放行后账本晋升 confirmed，doctor 全绿", async () => {
    // 0. 契约目录里必须已经登记这三个事件类型（写路径不校验，但契约是冻结的）
    expect(EVENT_TYPES).toContain("cli.message.received");
    expect(EVENT_TYPES).toContain("ledger.entry.reconfirmed");
    expect(EVENT_TYPES).toContain("ledger.entry.overturn_requested");

    // 1. cord init + 新建 session（真实目录布局）
    const init = await runInit(root);
    expect(init.created).toContain("cord");
    const cord_root = path.join(root, "cord");
    const session = await initSession(cord_root, REQ_ID);
    expect(session.dir).toBe(path.join(cord_root, REQ_ID));

    await writeFixtures();

    // 2. CLI 适配器入站：一条消息 + 一条命令都落到事件流
    await session.events.append(buildCliMessageDraft(normalizeCliInput("/cord new REQ-E2E-1"), REQ_ID));
    await session.events.append(
      buildCliMessageDraft(normalizeCliInput("锚点已补齐，请复核条目 C-1"), REQ_ID),
    );

    // 3. 提议条目：锚点指向临时目录里真实存在的文件与符号
    const verify_anchor = createAnchorVerifier(root);
    expect(await verify_anchor(CODE_ANCHOR)).toBe(true);
    expect(await verify_anchor(DOC_ANCHOR)).toBe(true);

    const title = "锚点存在 + k=2 盲评一致即晋升 confirmed";
    const anchors: Anchor[] = [{ ...CODE_ANCHOR, snapshot: { content_hash: sha256(TARGET_TS) } }];
    const proposed = await session.events.append(
      buildEventDraft({
        session_id: REQ_ID,
        type: "ledger.entry.proposed",
        actor: { kind: "agent", id: "explore-agent" },
        payload: {
          entry_id: ENTRY_ID,
          title,
          statement: "锚点可机验且两名评审独立达成一致时，条目由 provisional 晋升 confirmed。",
          status: "provisional",
          anchors,
        },
      }),
    );

    // 4. k=2 盲评：两票锚点不同源（无重合），结论一致 → confirmed
    const record = await createVoteExecutor().run({
      decision_point: {
        id: "DP-E2E-1",
        question: `是否确认「${title}」？`,
        options: ["confirm", "reject"],
        machine_verifiable: true,
        context_pack: `条目 ${ENTRY_ID} 的锚点：${CODE_ANCHOR.anchor}（只读快照，自行取证）`,
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
                  anchors: [DOC_ANCHOR],
                  confidence: 0.8,
                  reason: "验收规则文档中的 e2e-acceptance 段落支持该结论。",
                },
              },
            ],
          }),
        },
      ],
      verify_anchor,
    });
    expect(record.ballots).toHaveLength(2);
    expect(record.verdict).toBe("confirmed");
    expect(record.stats.anchor_overlap).toBe(0);

    const vote_event = await session.events.append(
      buildEventDraft({
        session_id: REQ_ID,
        type: "vote.completed",
        actor: { kind: "system", id: "voting" },
        correlation_id: proposed.event_id,
        source_adapter: "system",
        payload: {
          entry_id: ENTRY_ID,
          vote_id: record.vote_id,
          decision: record.verdict,
          anchor_overlap: record.stats.anchor_overlap,
          vote_record: record,
        },
      }),
    );

    // 5. 真实执行器 + 内置 gate（注册表刻意不绑 session，账本经 ctx.session 读到）
    const def = parseWorkflow(E2E_WORKFLOW_YAML, { source: "e2e" });
    const gate_payload = {
      entry_id: ENTRY_ID,
      anchors,
      vote_id: record.vote_id,
      vote_verdict: record.verdict,
      vote_record: record,
      machine_verifiable: true,
    };
    await createExecutor({ humanGate: NO_HUMAN, payload: gate_payload }).run(def, session);

    const after_first_run = await session.events.readAll();
    expect(gateResults(after_first_run, "gate-anchors")).toEqual(["pass"]);
    expect(gateResults(after_first_run, "gate-vote")).toEqual(["pass"]);
    expect(nodeCounts(after_first_run, "review", "workflow.node.exited")).toBe(1);
    // 账本还没 confirmed：确认节点被门禁挡下，停在等待重试的形态
    expect(gateResults(after_first_run, "gate-ledger")).toEqual(["block"]);
    expect(nodeCounts(after_first_run, "confirm", "workflow.node.exited")).toBe(0);

    // 6. 落账 → 重开 session 续跑（按事件流扫点恢复）
    await session.events.append(
      buildEventDraft({
        session_id: REQ_ID,
        type: "ledger.entry.confirmed",
        actor: { kind: "system", id: "consensus" },
        correlation_id: vote_event.event_id,
        source_adapter: "system",
        payload: {
          entry_id: ENTRY_ID,
          confidence_source: "vote_agreement",
          vote_record_id: record.vote_id,
        },
      }),
    );
    // 账本文件刻意删掉（模拟被杀在写投影之间）：确认节点的 checker 只能经 ctx.session 读事件流重投影。
    // 若执行器没把 session 放进 CheckerContext，这里会 fail-closed 阻断、续跑失败。
    await rm(path.join(session.dir, "ledger.yaml"));

    const resumed = await openSession(cord_root, REQ_ID);
    await createExecutor({ humanGate: NO_HUMAN, payload: gate_payload }).run(def, resumed);

    const events = await resumed.events.readAll();
    // 已完成节点不重放：review 的 entered / exited 各仍只有 1 条
    expect(nodeCounts(events, "review", "workflow.node.entered")).toBe(1);
    expect(nodeCounts(events, "review", "workflow.node.exited")).toBe(1);
    // 未完成的 confirm 被重新求值：gate-ledger 留下重试痕迹，最后一条才是最新判定
    expect(gateResults(events, "gate-ledger")).toEqual(["block", "pass"]);
    expect(nodeCounts(events, "confirm", "workflow.node.exited")).toBe(1);

    // 7. 投影与事件流一致，doctor（core + CLI 两层）全绿
    const rebuilt = await resumed.rebuildLedger();
    const ledger = await resumed.readLedger();
    expect(ledger.output_hash).toBe(rebuilt.output_hash);
    expect(ledger.entries).toHaveLength(1);
    const entry = ledger.entries[0];
    expect(entry?.entry_id).toBe(ENTRY_ID);
    expect(entry?.status).toBe("confirmed");
    expect(entry?.confidence_source).toBe("vote_agreement");
    expect(entry?.vote_record_id).toBe(record.vote_id);
    expect(entry?.conflict).toBe(false);

    const doctor = await resumed.doctor();
    expect(doctor.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`)).toEqual([]);
    expect(doctor.ok).toBe(true);

    const cli_doctor = await runDoctor(root);
    expect(cli_doctor.sessions).toEqual([REQ_ID]);
    expect(cli_doctor.ok).toBe(true);

    // 8. 已固化 payload schema 与真实事件逐条对齐
    expect(await payloadSchemaFailures(resumed)).toEqual([]);
  });
});

describe("M2 闭环：执行中途被杀后的恢复", () => {
  it("重新 run 时已完成节点不重复产生事件", async () => {
    await runInit(root);
    const cord_root = path.join(root, "cord");
    const session = await initSession(cord_root, KILL_REQ_ID);
    await writeFixtures();

    const def = parseWorkflow(KILL_WORKFLOW_YAML, { source: "e2e-kill" });
    const payload = { anchors: [CODE_ANCHOR] };

    // 节点 a 跑完（entered + gate.resolved + exited = 3 次 append）后进程被杀
    const crashing = sessionFailingAfterAppend(session, 3);
    await expect(createExecutor({ humanGate: NO_HUMAN, payload }).run(def, crashing)).rejects.toThrow(
      /模拟进程被杀/,
    );

    const interrupted = await session.events.readAll();
    expect(nodeCounts(interrupted, "a", "workflow.node.entered")).toBe(1);
    expect(nodeCounts(interrupted, "a", "workflow.node.exited")).toBe(1);
    expect(gateResults(interrupted, "gate-a")).toEqual(["pass"]);
    expect(nodeCounts(interrupted, "b", "workflow.node.entered")).toBe(0);

    // 重新 run：a 已 exited → 整节点跳过（不再产生任何 a 的事件），从 b 续跑
    const resumed = await openSession(cord_root, KILL_REQ_ID);
    await createExecutor({ humanGate: NO_HUMAN, payload }).run(def, resumed);

    const events = await resumed.events.readAll();
    expect(nodeCounts(events, "a", "workflow.node.entered")).toBe(1);
    expect(nodeCounts(events, "a", "workflow.node.exited")).toBe(1);
    expect(gateResults(events, "gate-a")).toEqual(["pass"]);
    expect(nodeCounts(events, "b", "workflow.node.entered")).toBe(1);
    expect(nodeCounts(events, "b", "workflow.node.exited")).toBe(1);
    expect(gateResults(events, "gate-b")).toEqual(["pass"]);

    await resumed.rebuildLedger();
    expect((await resumed.doctor()).ok).toBe(true);
    expect(await payloadSchemaFailures(resumed)).toEqual([]);
  });
});
