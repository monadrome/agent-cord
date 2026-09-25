/**
 * 薄执行器测试：事件顺序、环检测、崩溃恢复、gate 三分支、unknown checker fail-closed。
 * 全部用内存 fake 实现 ports.ts 的接口（不依赖 src/core 的实现细节）。
 */
import { describe, expect, it } from "vitest";
import {
  EventDraftSchema,
  EventEnvelopeSchema,
  WorkflowDefSchema,
  type EventEnvelope,
  type Ledger,
  type WorkflowDef,
} from "../../src/core/schema.js";
import type { EventStore, HumanGate, SessionHandle } from "../../src/core/ports.js";
import { WorkflowCycleError, WorkflowDefinitionError, createExecutor } from "../../src/workflow/executor.js";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const EMPTY_LEDGER: Ledger = {
  reducer_version: "test",
  input_hash: "0",
  output_hash: "0",
  entries: [],
};

function createFakeSession(options: { ledger?: Ledger } = {}) {
  const events: EventEnvelope[] = [];
  let seq = 0;
  let prev: string | null = null;
  let eventLimit = Number.POSITIVE_INFINITY;

  const store: EventStore = {
    async append(draft) {
      if (events.length >= eventLimit) throw new Error("simulated crash: 事件存储不可用");
      const parsed = EventDraftSchema.parse(draft);
      seq += 1;
      const envelope = EventEnvelopeSchema.parse({
        ...parsed,
        seq,
        prev_event_hash: prev,
        timestamp: new Date().toISOString(),
      });
      events.push(envelope);
      prev = envelope.event_id;
      return envelope;
    },
    async readAll() {
      return [...events];
    },
    async readOrdered() {
      return [...events];
    },
    subscribe() {
      return () => undefined;
    },
  };

  const ledger = options.ledger ?? EMPTY_LEDGER;
  const session: SessionHandle = {
    req_id: "req-test",
    dir: "/tmp/cord/req-test",
    events: store,
    async readLedger() {
      return ledger;
    },
    async rebuildLedger() {
      return ledger;
    },
    async doctor() {
      return { ok: true, checks: [] };
    },
  };

  return {
    session,
    events,
    crashAfter(appended: number) {
      eventLimit = appended;
    },
    recover() {
      eventLimit = Number.POSITIVE_INFINITY;
    },
  };
}

function chooseOption(index: 0 | 1): HumanGate {
  return {
    async ask(_question, options) {
      return options[index] ?? "";
    },
  };
}

function recordingGate(index: 0 | 1): { humanGate: HumanGate; asks: Array<{ question: string; options: string[] }> } {
  const asks: Array<{ question: string; options: string[] }> = [];
  return {
    asks,
    humanGate: {
      async ask(question, options) {
        asks.push({ question, options: [...options] });
        return options[index] ?? "";
      },
    },
  };
}

function crashingGate(): HumanGate {
  return {
    async ask() {
      throw new Error("simulated crash: 进程在等待人工时被杀");
    },
  };
}

function silentGate(): HumanGate {
  return {
    async ask() {
      return new Promise<string>(() => undefined);
    },
  };
}

const ANCHOR = { kind: "code", anchor: "src/workflow/executor.ts#createExecutor" };

interface GateFixture {
  id: string;
  node: string;
  ref?: string;
  when?: "pre" | "post";
  on_fail?: "block" | "warn" | "escalate";
  require?: "all" | "any";
  human_confirm?: boolean;
  timeout?: { after: string; on_timeout: "escalate_human" };
}

function gate(fixture: GateFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    role: { initiators: [], approvers: [] },
    attach: { node: fixture.node, when: fixture.when ?? "post", triggers: [] },
    checks: [{ ref: fixture.ref ?? "anchors-present" }],
    pass: { require: fixture.require ?? "all", human_confirm: fixture.human_confirm ?? false },
    on_fail: fixture.on_fail ?? "block",
    write_back: ["session_event"],
    ...(fixture.timeout ? { timeout: fixture.timeout } : {}),
  };
}

function workflow(
  nodes: Array<{
    id: string;
    depends_on?: string[];
    artifact?: string;
    gates?: Array<Record<string, unknown>>;
  }>,
): WorkflowDef {
  return WorkflowDefSchema.parse({
    apiVersion: "agent-cord.dev/v1alpha1",
    kind: "Workflow",
    metadata: { id: "wf-test", name: "测试流程" },
    spec: {
      nodes: nodes.map((node) => ({
        id: node.id,
        artifact: node.artifact,
        depends_on: node.depends_on ?? [],
        gates: node.gates ?? [],
      })),
    },
  });
}

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type);
}

function payloads(events: readonly EventEnvelope[], type: string): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

function nodeSequence(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === "workflow.node.entered" || event.type === "workflow.node.exited")
    .map((event) => `${event.type === "workflow.node.entered" ? "+" : "-"}${String((event.payload as Record<string, unknown>)["node_id"])}`);
}

// ---------------------------------------------------------------------------
// 拓扑推进
// ---------------------------------------------------------------------------

describe("executor: 拓扑推进与事件落盘", () => {
  it("线性图按序执行，gate 事件插在节点内，产物只做事件记录", async () => {
    const def = workflow([
      { id: "intake" },
      { id: "explore", depends_on: ["intake"], gates: [gate({ id: "anchor-check", node: "explore" })] },
      { id: "plan", depends_on: ["explore"], artifact: "plan.md" },
    ]);
    const fake = createFakeSession();
    const executor = createExecutor({ humanGate: chooseOption(0), payload: { anchors: [ANCHOR] } });

    await executor.run(def, fake.session);

    expect(types(fake.events)).toEqual([
      "workflow.node.entered",
      "workflow.node.exited",
      "workflow.node.entered",
      "gate.resolved",
      "workflow.node.exited",
      "workflow.node.entered",
      "workflow.node.exited",
    ]);
    expect(nodeSequence(fake.events)).toEqual([
      "+intake",
      "-intake",
      "+explore",
      "-explore",
      "+plan",
      "-plan",
    ]);
    expect(fake.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fake.events[0]?.prev_event_hash).toBeNull();
    expect(fake.events.map((event) => event.actor.kind)).toEqual(Array(7).fill("system"));
    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({
      node_id: "explore",
      gate_id: "anchor-check",
      result: "pass",
      action: "continue",
      human_confirmed: false,
    });
    expect(payloads(fake.events, "workflow.node.exited").map((payload) => payload["artifact"])).toEqual([
      null,
      null,
      "plan.md",
    ]);
    // pre 在 post 之前
    const order = payloads(fake.events, "gate.waiting").length;
    expect(order).toBe(0);
  });

  it("同层节点按定义序稳定择先，且依赖先于后继", async () => {
    const def = workflow([
      { id: "a" },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "d", depends_on: ["b", "c"] },
    ]);
    const fake = createFakeSession();
    await createExecutor({ humanGate: chooseOption(0) }).run(def, fake.session);

    expect(payloads(fake.events, "workflow.node.entered").map((payload) => payload["node_id"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("环检测报错且不产生任何事件", async () => {
    const def = workflow([
      { id: "a", depends_on: ["c"] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["b"] },
    ]);
    const fake = createFakeSession();
    const executor = createExecutor({ humanGate: chooseOption(0) });

    await expect(executor.run(def, fake.session)).rejects.toBeInstanceOf(WorkflowCycleError);
    await expect(executor.run(def, fake.session)).rejects.toThrow(/存在环/);
    expect(fake.events).toEqual([]);
  });

  it("pre 的 gate 先于 post 的 gate 执行", async () => {
    const def = workflow([
      {
        id: "plan",
        gates: [
          gate({ id: "post-gate", node: "plan", when: "post" }),
          gate({ id: "pre-gate", node: "plan", when: "pre" }),
        ],
      },
    ]);
    const fake = createFakeSession();
    await createExecutor({ humanGate: chooseOption(0), payload: { anchors: [ANCHOR] } }).run(def, fake.session);

    expect(payloads(fake.events, "gate.resolved").map((payload) => payload["gate_id"])).toEqual([
      "pre-gate",
      "post-gate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

describe("executor: 崩溃后重新 run（扫点恢复）", () => {
  it("跳过已完成节点，只重跑未退出节点", async () => {
    const def = workflow([{ id: "a" }, { id: "b", depends_on: ["a"] }, { id: "c", depends_on: ["b"] }]);
    const fake = createFakeSession();
    const executor = createExecutor({ humanGate: chooseOption(0) });

    fake.crashAfter(3);
    await expect(executor.run(def, fake.session)).rejects.toThrow("simulated crash");
    expect(nodeSequence(fake.events)).toEqual(["+a", "-a", "+b"]);

    fake.recover();
    await executor.run(def, fake.session);
    expect(nodeSequence(fake.events)).toEqual(["+a", "-a", "+b", "+b", "-b", "+c", "-c"]);
    const entered = payloads(fake.events, "workflow.node.entered").filter(
      (payload) => payload["node_id"] === "b",
    );
    expect(entered.map((payload) => payload["resumed"])).toEqual([false, true]);

    const settled = fake.events.length;
    await executor.run(def, fake.session);
    expect(fake.events.length).toBe(settled);
  });

  it("恢复时重新发起 waiting 的 gate 询问，并复用原选择题", async () => {
    const def = workflow([
      { id: "a" },
      {
        id: "b",
        depends_on: ["a"],
        gates: [gate({ id: "verdict", node: "b", ref: "vote-confirmed", on_fail: "escalate" })],
      },
    ]);
    const fake = createFakeSession();

    await expect(
      createExecutor({ humanGate: crashingGate() }).run(def, fake.session),
    ).rejects.toThrow("simulated crash");
    expect(types(fake.events)).toEqual([
      "workflow.node.entered",
      "workflow.node.exited",
      "workflow.node.entered",
      "gate.waiting",
    ]);
    expect(payloads(fake.events, "gate.waiting")[0]).toMatchObject({
      node_id: "b",
      gate_id: "verdict",
      kind: "escalation",
      options: ["放行", "终止"],
      timed_out: false,
    });

    const recorder = recordingGate(0);
    await createExecutor({ humanGate: recorder.humanGate }).run(def, fake.session);

    expect(recorder.asks).toHaveLength(1);
    expect(recorder.asks[0]?.options).toEqual(["放行", "终止"]);
    expect(recorder.asks[0]?.question).toContain("verdict");
    // a 不再重入；b 重新进入并退出
    expect(nodeSequence(fake.events)).toEqual(["+a", "-a", "+b", "+b", "-b"]);
    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({
      gate_id: "verdict",
      result: "pass",
      action: "continue",
      human_confirmed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// gate 分支
// ---------------------------------------------------------------------------

describe("executor: gate 三态与人工分支", () => {
  it("on_fail=block 时中止流程：gate 停下、节点不退出、后继不进入", async () => {
    const def = workflow([
      { id: "verify", gates: [gate({ id: "g", node: "verify", ref: "vote-confirmed" })] },
      { id: "release", depends_on: ["verify"] },
    ]);
    const recorder = recordingGate(0);
    const fake = createFakeSession();

    await createExecutor({ humanGate: recorder.humanGate, payload: { vote_verdict: "abstain" } }).run(
      def,
      fake.session,
    );

    expect(types(fake.events)).toEqual(["workflow.node.entered", "gate.resolved"]);
    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({
      node_id: "verify",
      result: "block",
      action: "stop",
    });
    expect(recorder.asks).toEqual([]);
  });

  it("on_fail=warn 时留痕并继续", async () => {
    const def = workflow([
      { id: "verify", gates: [gate({ id: "g", node: "verify", ref: "vote-confirmed", on_fail: "warn" })] },
      { id: "release", depends_on: ["verify"] },
    ]);
    const fake = createFakeSession();

    await createExecutor({ humanGate: chooseOption(0) }).run(def, fake.session);

    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({ result: "warn", action: "continue" });
    expect(types(fake.events)).toEqual([
      "workflow.node.entered",
      "gate.resolved",
      "workflow.node.exited",
      "workflow.node.entered",
      "workflow.node.exited",
    ]);
  });

  it("on_fail=escalate：人放行则继续，人选终止则停下", async () => {
    const def = workflow([
      { id: "verify", gates: [gate({ id: "g", node: "verify", ref: "vote-confirmed", on_fail: "escalate" })] },
    ]);

    const allow = createFakeSession();
    await createExecutor({ humanGate: chooseOption(0) }).run(def, allow.session);
    expect(types(allow.events)).toEqual([
      "workflow.node.entered",
      "gate.waiting",
      "gate.resolved",
      "workflow.node.exited",
    ]);
    expect(payloads(allow.events, "gate.waiting")[0]).toMatchObject({
      kind: "escalation",
      options: ["放行", "终止"],
    });
    expect(payloads(allow.events, "gate.resolved")[0]).toMatchObject({
      result: "pass",
      action: "continue",
      human_confirmed: true,
    });

    const deny = createFakeSession();
    await createExecutor({ humanGate: chooseOption(1) }).run(def, deny.session);
    expect(types(deny.events)).toEqual(["workflow.node.entered", "gate.waiting", "gate.resolved"]);
    expect(payloads(deny.events, "gate.resolved")[0]).toMatchObject({ result: "block", action: "stop" });
  });

  it("human_confirm：pass 也要人确认，拒绝则 block", async () => {
    const def = workflow([
      {
        id: "plan",
        gates: [gate({ id: "g", node: "plan", human_confirm: true })],
      },
    ]);
    const payload = { anchors: [ANCHOR] };

    const allow = createFakeSession();
    await createExecutor({ humanGate: chooseOption(0), payload }).run(def, allow.session);
    expect(types(allow.events)).toEqual([
      "workflow.node.entered",
      "gate.waiting",
      "gate.resolved",
      "workflow.node.exited",
    ]);
    expect(payloads(allow.events, "gate.waiting")[0]).toMatchObject({
      kind: "human_confirm",
      result: "pass",
      options: ["确认放行", "拒绝放行"],
    });
    expect(payloads(allow.events, "gate.resolved")[0]).toMatchObject({
      result: "pass",
      human_confirmed: true,
      action: "continue",
    });

    const deny = createFakeSession();
    await createExecutor({ humanGate: chooseOption(1), payload }).run(def, deny.session);
    expect(payloads(deny.events, "gate.resolved")[0]).toMatchObject({
      result: "block",
      action: "stop",
      human_confirmed: false,
    });
    expect(nodeSequence(deny.events)).toEqual(["+plan"]);
  });

  it("human_confirm 未被调用时（check 未通过）走 on_fail", async () => {
    const def = workflow([
      { id: "plan", gates: [gate({ id: "g", node: "plan", human_confirm: true })] },
    ]);
    const recorder = recordingGate(0);
    const fake = createFakeSession();

    await createExecutor({ humanGate: recorder.humanGate, payload: { anchors: [] } }).run(def, fake.session);

    expect(recorder.asks).toEqual([]);
    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({ result: "block", action: "stop" });
  });

  it("require=any：至少一个 check 通过即放行", async () => {
    const def = workflow([
      {
        id: "verify",
        gates: [
          {
            ...gate({ id: "g", node: "verify", ref: "vote-confirmed", require: "any" }),
            checks: [{ ref: "vote-confirmed" }, { ref: "anchors-present" }],
          },
        ],
      },
    ]);
    const fake = createFakeSession();

    await createExecutor({ humanGate: chooseOption(0), payload: { anchors: [ANCHOR] } }).run(def, fake.session);

    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({ result: "pass", action: "continue" });
  });
});

// ---------------------------------------------------------------------------
// fail-closed
// ---------------------------------------------------------------------------

describe("executor: fail-closed", () => {
  it("未知 checker 名 → block（不放行），且不询问人工", async () => {
    const def = workflow([
      { id: "verify", gates: [gate({ id: "g", node: "verify", ref: "no-such-checker" })] },
      { id: "release", depends_on: ["verify"] },
    ]);
    const recorder = recordingGate(0);
    const fake = createFakeSession();

    await createExecutor({ humanGate: recorder.humanGate }).run(def, fake.session);

    const resolved = payloads(fake.events, "gate.resolved")[0];
    expect(resolved).toMatchObject({ result: "block", action: "stop" });
    expect(String(resolved?.["reason"])).toContain("no-such-checker");
    expect(recorder.asks).toEqual([]);
    expect(nodeSequence(fake.events)).toEqual(["+verify"]);
  });

  it("checker 抛错也 fail-closed 成 block", async () => {
    const def = workflow([{ id: "verify", gates: [gate({ id: "g", node: "verify", ref: "boom" })] }]);
    const fake = createFakeSession();
    const registry = {
      register() {},
      get(name: string) {
        if (name !== "boom") return undefined;
        return {
          name: "boom",
          async check() {
            throw new Error("checker 内部错误");
          },
        };
      },
    };

    await createExecutor({ humanGate: chooseOption(0), registry }).run(def, fake.session);

    const resolved = payloads(fake.events, "gate.resolved")[0];
    expect(resolved).toMatchObject({ result: "block", action: "stop" });
    expect(String(resolved?.["reason"])).toContain("fail-closed");
  });

  it("空 checks 的 gate 不放行（配置层已被 loader 拒绝，执行层兜底）", async () => {
    const def = workflow([
      { id: "verify", gates: [{ ...gate({ id: "g", node: "verify" }), checks: [] }] },
    ]);
    const fake = createFakeSession();

    await createExecutor({ humanGate: chooseOption(0), payload: { anchors: [ANCHOR] } }).run(def, fake.session);

    expect(payloads(fake.events, "gate.resolved")[0]).toMatchObject({ result: "block", action: "stop" });
  });

  it("timeout.on_timeout=escalate_human：等待超时后不放行、保持挂起", async () => {
    const def = workflow([
      {
        id: "verify",
        gates: [
          gate({
            id: "g",
            node: "verify",
            ref: "vote-confirmed",
            on_fail: "escalate",
            timeout: { after: "20ms", on_timeout: "escalate_human" },
          }),
        ],
      },
    ]);
    const fake = createFakeSession();

    await createExecutor({ humanGate: silentGate() }).run(def, fake.session);

    expect(types(fake.events)).toEqual([
      "workflow.node.entered",
      "gate.waiting",
      "gate.waiting",
    ]);
    expect(payloads(fake.events, "gate.waiting").map((payload) => payload["timed_out"])).toEqual([
      false,
      true,
    ]);
    expect(payloads(fake.events, "gate.resolved")).toEqual([]);
  });

  it("无法解析的 timeout.after 直接报配置错误", async () => {
    const def = workflow([
      {
        id: "verify",
        gates: [
          gate({
            id: "g",
            node: "verify",
            ref: "vote-confirmed",
            on_fail: "escalate",
            timeout: { after: "soon", on_timeout: "escalate_human" },
          }),
        ],
      },
    ]);
    const fake = createFakeSession();

    await expect(
      createExecutor({ humanGate: silentGate() }).run(def, fake.session),
    ).rejects.toThrow(WorkflowDefinitionError);
  });
});
