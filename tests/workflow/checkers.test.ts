/**
 * 参数化内置 checker 测试（ADR-0024）：
 * file-exists / file-nonempty / doc-has-section / anchors-min-count / event-emitted，
 * 以及 checks[].with 经执行器透传到 CheckerContext.params 的集成路径。
 * 约定：参数非法一律 block（fail-closed），path 禁止越出 session 目录。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Checker, CheckerContext } from "../../src/core/ports.js";
import {
  EventDraftSchema,
  EventEnvelopeSchema,
  type EventEnvelope,
  type Ledger,
  type SessionHandle,
} from "../../src/index.js";
import {
  createAnchorsMinCountChecker,
  createDocHasSectionChecker,
  createEventEmittedChecker,
  createExecutor,
  createFileExistsChecker,
  createFileNonemptyChecker,
  createVerificationPassedChecker,
  type WorkflowDef,
} from "../../src/index.js";

let sessionDir: string;

beforeEach(async () => {
  sessionDir = await mkdtemp(join(tmpdir(), "cord-checkers-"));
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

function ctx(params?: Record<string, unknown>, extra: Partial<CheckerContext> = {}): CheckerContext {
  return { session_dir: sessionDir, anchors: [], payload: {}, params, ...extra };
}

// ---------------------------------------------------------------------------
// file-exists
// ---------------------------------------------------------------------------

describe("file-exists", () => {
  it("文件存在 → pass，带 doc 锚点", async () => {
    await writeFile(join(sessionDir, "plan.md"), "# Plan\n", "utf8");
    const result = await createFileExistsChecker().check(ctx({ path: "plan.md" }));
    expect(result.result).toBe("pass");
    expect(result.anchors[0]?.anchor).toContain("plan.md");
  });

  it("文件不存在 → block", async () => {
    const result = await createFileExistsChecker().check(ctx({ path: "nope.md" }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("nope.md");
  });

  it("path 越出 session 目录 → block", async () => {
    const result = await createFileExistsChecker().check(ctx({ path: "../../etc/passwd" }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("越出");
  });

  it("参数非法（缺 path）→ block（fail-closed）", async () => {
    const result = await createFileExistsChecker().check(ctx({}));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("参数非法");
  });
});

// ---------------------------------------------------------------------------
// file-nonempty
// ---------------------------------------------------------------------------

describe("file-nonempty", () => {
  it("实质内容达标 → pass", async () => {
    await writeFile(join(sessionDir, "plan.md", ), "# Plan\n\n步骤一：做 A。\n", "utf8");
    const result = await createFileNonemptyChecker().check(ctx({ path: "plan.md", min_bytes: 10 }));
    expect(result.result).toBe("pass");
  });

  it("只有 HTML 注释与空白 → block（注释不算实质内容）", async () => {
    await writeFile(join(sessionDir, "plan.md"), "<!-- 占位 -->\n\n", "utf8");
    const result = await createFileNonemptyChecker().check(ctx({ path: "plan.md" }));
    expect(result.result).toBe("block");
  });

  it("内容不足 min_bytes → block", async () => {
    await writeFile(join(sessionDir, "plan.md"), "hi", "utf8");
    const result = await createFileNonemptyChecker().check(ctx({ path: "plan.md", min_bytes: 100 }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("100");
  });

  it("文件不存在 → block", async () => {
    const result = await createFileNonemptyChecker().check(ctx({ path: "missing.md" }));
    expect(result.result).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// doc-has-section
// ---------------------------------------------------------------------------

describe("doc-has-section", () => {
  it("标题命中（大小写不敏感、忽略 # 层级）→ pass", async () => {
    await writeFile(join(sessionDir, "adr.md"), "# ADR\n\n## 决策\n\n内容\n", "utf8");
    const result = await createDocHasSectionChecker().check(ctx({ path: "adr.md", heading: "决策" }));
    expect(result.result).toBe("pass");
  });

  it("标题缺失 → block", async () => {
    await writeFile(join(sessionDir, "adr.md"), "# ADR\n\n## 背景\n", "utf8");
    const result = await createDocHasSectionChecker().check(ctx({ path: "adr.md", heading: "决策" }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("决策");
  });

  it("文档不存在 → block", async () => {
    const result = await createDocHasSectionChecker().check(ctx({ path: "adr.md", heading: "x" }));
    expect(result.result).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// anchors-min-count
// ---------------------------------------------------------------------------

describe("anchors-min-count", () => {
  const anchor = { kind: "doc", anchor: "cord/REQ-1/plan.md" } as const;

  it("锚点数量达标 → pass", async () => {
    const result = await createAnchorsMinCountChecker().check(
      ctx({ min: 2 }, { payload: { anchors: [anchor, anchor, anchor] } }),
    );
    expect(result.result).toBe("pass");
  });

  it("锚点不足 → block；非法锚点不计入", async () => {
    const result = await createAnchorsMinCountChecker().check(
      ctx({ min: 2 }, { payload: { anchors: [anchor, { bogus: true }] } }),
    );
    expect(result.result).toBe("block");
    expect(result.reason).toContain("1 个 < 要求 2 个");
  });

  it("参数非法（min 为 0）→ block", async () => {
    const result = await createAnchorsMinCountChecker().check(ctx({ min: 0 }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("参数非法");
  });
});

// ---------------------------------------------------------------------------
// event-emitted
// ---------------------------------------------------------------------------

const EMPTY_LEDGER: Ledger = { reducer_version: "test", input_hash: "0", output_hash: "0", entries: [] };

function makeEnvelope(type: string, correlationId: string | null, seq: number, payload: Record<string, unknown> = {}): EventEnvelope {
  return EventEnvelopeSchema.parse({
    event_id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, "0")}`,
    session_id: "REQ-T",
    seq,
    prev_event_hash: null,
    type,
    schema_version: "1",
    timestamp: new Date().toISOString(),
    actor: { kind: "system", id: "test" },
    correlation_id: correlationId,
    payload,
    source: { adapter: "test" },
  });
}

function fakeSessionWithEvents(events: EventEnvelope[]): SessionHandle {
  return {
    req_id: "REQ-T",
    dir: sessionDir,
    events: {
      append: async (draft) => {
        const parsed = EventDraftSchema.parse(draft);
        return makeEnvelope(parsed.type, parsed.correlation_id, events.length + 1);
      },
      readAll: async () => [...events],
      readOrdered: async () => [...events],
      subscribe: () => () => undefined,
    },
    readLedger: async () => EMPTY_LEDGER,
    rebuildLedger: async () => EMPTY_LEDGER,
    doctor: async () => ({ ok: true, checks: [] }),
  };
}

describe("event-emitted", () => {
  it("事件流（经 session）含目标类型 → pass", async () => {
    const session = fakeSessionWithEvents([
      makeEnvelope("workflow.node.entered", "plan", 1),
      makeEnvelope("agent.task.completed", "plan", 2),
    ]);
    const result = await createEventEmittedChecker().check(
      ctx({ type: "agent.task.completed" }, { session }),
    );
    expect(result.result).toBe("pass");
  });

  it("无 session 时退回读 events.jsonl", async () => {
    await writeFile(
      join(sessionDir, "events.jsonl"),
      `${JSON.stringify(makeEnvelope("agent.task.completed", "plan", 1))}\n`,
      "utf8",
    );
    const result = await createEventEmittedChecker().check(ctx({ type: "agent.task.completed" }));
    expect(result.result).toBe("pass");
  });

  it("类型未出现 → block", async () => {
    const session = fakeSessionWithEvents([makeEnvelope("workflow.node.entered", "plan", 1)]);
    const result = await createEventEmittedChecker().check(
      ctx({ type: "agent.task.completed" }, { session }),
    );
    expect(result.result).toBe("block");
  });

  it("within_node=true 只认当前节点 correlation_id", async () => {
    const session = fakeSessionWithEvents([makeEnvelope("agent.task.completed", "other-node", 1)]);
    const checker = createEventEmittedChecker();
    const hit = await checker.check(
      ctx({ type: "agent.task.completed", within_node: true }, { session, node_id: "other-node" }),
    );
    expect(hit.result).toBe("pass");
    const miss = await checker.check(
      ctx({ type: "agent.task.completed", within_node: true }, { session, node_id: "plan" }),
    );
    expect(miss.result).toBe("block");
  });

  it("within_node=true 但无节点上下文 → block", async () => {
    const session = fakeSessionWithEvents([]);
    const result = await createEventEmittedChecker().check(
      ctx({ type: "x.y", within_node: true }, { session }),
    );
    expect(result.result).toBe("block");
    expect(result.reason).toContain("node_id");
  });
});

describe("verification-passed", () => {
  const input_hash = "a".repeat(64);
  const command_hash = "b".repeat(64);
  const verification = (status: string, hash = input_hash): EventEnvelope => makeEnvelope(
    "verification.completed",
    "verify",
    1,
    { workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify", verification_id: "unit-tests", input_hash: hash, command_hash, status },
  );

  it("只接受当前输入指纹且状态为 passed 的宿主事实", async () => {
    const result = await createVerificationPassedChecker().check(ctx(
      { verification_id: "unit-tests" },
      { session: fakeSessionWithEvents([verification("passed")]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify", input_hash },
    ));
    expect(result.result).toBe("pass");
  });

  it("旧 hash、失败结果和缺少上下文均 fail-closed", async () => {
    const checker = createVerificationPassedChecker();
    const stale = await checker.check(ctx(
      { verification_id: "unit-tests" },
      { session: fakeSessionWithEvents([verification("passed", "c".repeat(64))]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify", input_hash },
    ));
    expect(stale.result).toBe("block");
    const failed = await checker.check(ctx(
      { verification_id: "unit-tests" },
      { session: fakeSessionWithEvents([verification("failed")]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify", input_hash },
    ));
    expect(failed.result).toBe("block");
    const missing = await checker.check(ctx(
      { verification_id: "unit-tests" },
      { session: fakeSessionWithEvents([verification("passed")]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify" },
    ));
    expect(missing.result).toBe("block");
  });

  it("不同 run 的同输入验证事实不能复用", async () => {
    const result = await createVerificationPassedChecker().check(ctx(
      { verification_id: "unit-tests" },
      { session: fakeSessionWithEvents([verification("passed")]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F02", node_id: "verify", input_hash },
    ));
    expect(result.result).toBe("block");
  });

  it("显式空输入范围不能静默降级为无源码验证", async () => {
    const result = await createVerificationPassedChecker().check(ctx(
      { verification_id: "unit-tests", inputs: [] },
      { session: fakeSessionWithEvents([verification("passed")]), workflow_id: "wf", run_id: "01ARZ3NDEKTSV4RRFFQ69G5F01", node_id: "verify", input_hash },
    ));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("参数非法");
  });
});

// ---------------------------------------------------------------------------
// checks[].with 经执行器透传（集成）
// ---------------------------------------------------------------------------

describe("checks[].with 透传（执行器集成）", () => {
  it("gate 声明的 with 到达 CheckerContext.params", async () => {
    const seen: Record<string, unknown>[] = [];
    const probe: Checker = {
      name: "param-probe",
      async check(c) {
        seen.push(c.params ?? {});
        return { result: "pass", anchors: [], reason: "ok", confidence: 1 };
      },
    };
    const events: EventEnvelope[] = [];
    let seq = 0;
    const session = fakeSessionWithEvents(events);
    session.events.append = async (draft) => {
      const parsed = EventDraftSchema.parse(draft);
      seq += 1;
      const envelope = EventEnvelopeSchema.parse({
        ...parsed,
        seq,
        prev_event_hash: null,
        timestamp: new Date().toISOString(),
      });
      events.push(envelope);
      return envelope;
    };

    const def: WorkflowDef = {
      apiVersion: "agent-cord.dev/v1alpha1",
      kind: "Workflow",
      metadata: { id: "wf-params" },
      spec: {
        nodes: [
          {
            id: "n1",
            depends_on: [],
            gates: [
              {
                id: "g1",
                role: { initiators: [], approvers: [] },
                attach: { node: "n1", when: "post", triggers: [] },
                checks: [{ ref: "param-probe", with: { path: "plan.md", min: 2 } }],
                pass: { require: "all", human_confirm: false },
                on_fail: "block",
                write_back: [],
              },
            ],
          },
        ],
      },
    };

    const executor = createExecutor({
      humanGate: { ask: async () => "放行" },
      registry: { register: () => undefined, get: (name) => (name === "param-probe" ? probe : undefined) },
    });
    await executor.run(def, session);
    expect(seen).toEqual([{ path: "plan.md", min: 2 }]);
  });
});
