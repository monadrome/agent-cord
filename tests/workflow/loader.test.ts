/**
 * loader（YAML → WorkflowDef + 引用校验）与内置 checker 的测试。
 * session 用内存 fake 实现 ports.ts 的 SessionHandle。
 */
import { describe, expect, it } from "vitest";
import { LedgerSchema, type Ledger } from "../../src/core/schema.js";
import type { CheckerContext, SessionHandle } from "../../src/core/ports.js";
import {
  createAnchorsPresentChecker,
  createBuiltinRegistry,
  createLedgerHasConfirmedChecker,
  createVoteConfirmedChecker,
  findUnknownCheckers,
} from "../../src/workflow/checkers.js";
import { WorkflowLoadError, loadWorkflowFile, parseWorkflow } from "../../src/workflow/loader.js";
import { WorkflowDefSchema } from "../../src/core/schema.js";

const VALID_YAML = `
apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata:
  id: wf-demo
  name: 七步流程
spec:
  nodes:
    - id: intake
    - id: plan
      depends_on: [intake]
      artifact: plan.md
      gates:
        - id: contract-freeze
          role: { initiators: [backend], approvers: [architect] }
          attach: { node: plan, when: post, triggers: [contract.touched] }
          checks:
            - ref: anchors-present
          pass: { require: all, human_confirm: false }
`;

const LEDGER: Ledger = LedgerSchema.parse({
  reducer_version: "1",
  input_hash: "in",
  output_hash: "out",
  entries: [
    {
      entry_id: "C-001",
      title: "接口冻结",
      status: "confirmed",
      anchors: [{ kind: "code", anchor: "src/a.ts#A.b" }],
      confidence_source: "evidence_direct",
    },
    {
      entry_id: "C-002",
      title: "待验证",
      status: "provisional",
      anchors: [{ kind: "doc", anchor: "docs/b.md" }],
      confidence_source: "evidence_direct",
    },
  ],
});

function createFakeSession(options: { ledger?: Ledger; readError?: Error } = {}): SessionHandle {
  const ledger = options.ledger ?? LEDGER;
  return {
    req_id: "req-1",
    dir: "/tmp/cord/req-1",
    events: {
      async append() {
        throw new Error("本测试不追加事件");
      },
      async readAll() {
        return [];
      },
      async readOrdered() {
        return [];
      },
      subscribe() {
        return () => undefined;
      },
    },
    async readLedger() {
      if (options.readError) throw options.readError;
      return ledger;
    },
    async rebuildLedger() {
      return ledger;
    },
    async doctor() {
      return { ok: true, checks: [] };
    },
  };
}

function context(overrides: Partial<CheckerContext> = {}): CheckerContext {
  return { session_dir: "/tmp/cord/req-1", anchors: [], payload: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

describe("loader: YAML 加载与校验", () => {
  it("合法 YAML 加载成功并填上 schema 默认值", () => {
    const def = parseWorkflow(VALID_YAML, { source: "wf-demo.yaml" });

    expect(def.metadata.id).toBe("wf-demo");
    expect(def.spec.nodes.map((node) => node.id)).toEqual(["intake", "plan"]);
    expect(def.spec.nodes[0]?.depends_on).toEqual([]);
    expect(def.spec.nodes[1]?.gates[0]?.on_fail).toBe("block");
    expect(def.spec.nodes[1]?.gates[0]?.pass).toEqual({ require: "all", human_confirm: false });
    expect(def.spec.nodes[1]?.gates[0]?.checks).toEqual([{ ref: "anchors-present" }]);
  });

  it("schema 校验失败时给出带路径的错误", () => {
    const broken = VALID_YAML.replace("kind: Workflow", "kind: Pipeline");
    let error: WorkflowLoadError | null = null;
    try {
      parseWorkflow(broken, { source: "broken.yaml" });
    } catch (err) {
      error = err as WorkflowLoadError;
    }
    expect(error).toBeInstanceOf(WorkflowLoadError);
    expect(error?.source).toBe("broken.yaml");
    expect(error?.issues.join("\n")).toContain("kind");
    expect(error?.message).toContain("broken.yaml");
  });

  it("depends_on 指向不存在的节点时报错", () => {
    const text = VALID_YAML.replace("depends_on: [intake]", "depends_on: [nope]");
    expect(() => parseWorkflow(text)).toThrow(/depends_on\.0: 依赖的节点不存在：nope/);
  });

  it("gate.attach.node 与所属节点不一致时报错", () => {
    const text = VALID_YAML.replace("attach: { node: plan", "attach: { node: intake");
    expect(() => parseWorkflow(text)).toThrow(/attach\.node: 应等于所属节点 id "plan"/);
  });

  it("节点 id 重复时报错", () => {
    const text = VALID_YAML.replace("- id: plan", "- id: intake");
    expect(() => parseWorkflow(text)).toThrow(/节点 id 重复：intake/);
  });

  it("gate 未声明 checker 时报错（fail-closed）", () => {
    const text = VALID_YAML.replace("          checks:\n            - ref: anchors-present\n", "          checks: []\n");
    expect(() => parseWorkflow(text)).toThrow(/checks: gate 未声明任何 checker/);
  });

  it("YAML 语法错误被包装成 WorkflowLoadError", () => {
    expect(() => parseWorkflow("a: [1, 2\n", { source: "bad.yaml" })).toThrow(/YAML 解析失败/);
  });

  it("loadWorkflowFile 读取失败给出文件路径", async () => {
    await expect(loadWorkflowFile("does/not/exist.yaml")).rejects.toThrow(
      /does\/not\/exist\.yaml[\s\S]*无法读取文件/,
    );
  });

  it("loadWorkflowFile 读取到非 workflow 内容时按 schema 报错", async () => {
    await expect(loadWorkflowFile("package.json")).rejects.toBeInstanceOf(WorkflowLoadError);
  });
});

// ---------------------------------------------------------------------------
// checkers
// ---------------------------------------------------------------------------

describe("checkers: 内置注册表", () => {
  it("注册三个内置 checker，未知名字返回 undefined", () => {
    const registry = createBuiltinRegistry();
    expect(registry.get("anchors-present")?.name).toBe("anchors-present");
    expect(registry.get("ledger-has-confirmed")?.name).toBe("ledger-has-confirmed");
    expect(registry.get("vote-confirmed")?.name).toBe("vote-confirmed");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("register 可覆盖内置 checker", async () => {
    const registry = createBuiltinRegistry();
    registry.register({ name: "vote-confirmed", async check() { return { result: "warn", anchors: [], reason: "自定义", confidence: 0.5 }; } });
    const result = await registry.get("vote-confirmed")?.check(context());
    expect(result).toMatchObject({ result: "warn", confidence: 0.5 });
  });

  it("findUnknownCheckers 列出未注册的引用", () => {
    const def = WorkflowDefSchema.parse({
      apiVersion: "agent-cord.dev/v1alpha1",
      kind: "Workflow",
      metadata: { id: "wf" },
      spec: {
        nodes: [
          {
            id: "plan",
            gates: [
              {
                id: "g",
                role: {},
                attach: { node: "plan", when: "post" },
                checks: [{ ref: "anchors-present" }, { ref: "ci-gate@official" }],
                pass: {},
              },
            ],
          },
        ],
      },
    });
    expect(findUnknownCheckers(def, createBuiltinRegistry())).toEqual(["ci-gate@official"]);
  });
});

describe("checkers: anchors-present", () => {
  const checker = createAnchorsPresentChecker();

  it("payload.anchors 非空 → pass，并回带锚点", async () => {
    const result = await checker.check(
      context({ payload: { anchors: [{ kind: "code", anchor: "src/a.ts#A.b" }] } }),
    );
    expect(result.result).toBe("pass");
    expect(result.anchors).toEqual([{ kind: "code", anchor: "src/a.ts#A.b" }]);
  });

  it("缺失或空数组 → block", async () => {
    expect((await checker.check(context())).result).toBe("block");
    expect((await checker.check(context({ payload: { anchors: [] } }))).result).toBe("block");
    expect((await checker.check(context({ payload: { anchors: "x" } }))).result).toBe("block");
  });

  it("payload.anchors 缺省时退回 ctx.anchors", async () => {
    const result = await checker.check(
      context({ anchors: [{ kind: "test", anchor: "tests/a.test.ts#case-1" }] }),
    );
    expect(result.result).toBe("pass");
    expect(result.reason).toContain("ctx.anchors");
  });

  it("全是不合法锚点 → block", async () => {
    const result = await checker.check(context({ payload: { anchors: [{ kind: "code" }] } }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("无一合法");
  });
});

describe("checkers: vote-confirmed", () => {
  const checker = createVoteConfirmedChecker();

  it("vote_verdict === confirmed → pass", async () => {
    const result = await checker.check(context({ payload: { vote_verdict: "confirmed" } }));
    expect(result.result).toBe("pass");
  });

  it("其他取值或缺省 → block", async () => {
    expect((await checker.check(context({ payload: { vote_verdict: "abstain" } }))).result).toBe("block");
    expect((await checker.check(context())).result).toBe("block");
  });

  it("兼容 decision / vote_record.verdict 键（CLI demo 载荷形态）", async () => {
    const viaDecision = await checker.check(context({ payload: { decision: "confirmed" } }));
    expect(viaDecision.result).toBe("pass");
    expect(viaDecision.reason).toContain("payload.decision");
    const viaRecord = await checker.check(
      context({ payload: { vote_record: { verdict: "confirmed", vote_id: "V-1" } } }),
    );
    expect(viaRecord.result).toBe("pass");
    expect(viaRecord.reason).toContain("payload.vote_record.verdict");
    const nested = await checker.check(context({ payload: { vote_record: { verdict: "abstain" } } }));
    expect(nested.result).toBe("block");
  });
});

describe("checkers: ledger-has-confirmed", () => {
  it("经 session.readLedger() 读到 confirmed 条目 → pass", async () => {
    const checker = createLedgerHasConfirmedChecker({ session: createFakeSession() });
    const result = await checker.check(context());
    expect(result.result).toBe("pass");
    expect(result.reason).toContain("C-001");
    expect(result.anchors).toEqual([{ kind: "code", anchor: "src/a.ts#A.b" }]);
  });

  it("账本无 confirmed 条目 → block", async () => {
    const empty = createFakeSession({
      ledger: LedgerSchema.parse({ reducer_version: "1", input_hash: "i", output_hash: "o", entries: [] }),
    });
    const result = await createLedgerHasConfirmedChecker({ session: empty }).check(context());
    expect(result.result).toBe("block");
  });

  it("payload.entry_id 收窄判定范围", async () => {
    const checker = createLedgerHasConfirmedChecker({ session: createFakeSession() });
    const hit = await checker.check(context({ payload: { entry_id: "C-001" } }));
    const miss = await checker.check(context({ payload: { entry_id: "C-002" } }));
    expect(hit.result).toBe("pass");
    expect(miss.result).toBe("block");
    expect(miss.reason).toContain("C-002");
  });

  it("账本读取失败 → block（fail-closed）", async () => {
    const broken = createFakeSession({ readError: new Error("ledger.yaml 不存在") });
    const result = await createLedgerHasConfirmedChecker({ session: broken }).check(context());
    expect(result.result).toBe("block");
    expect(result.reason).toContain("fail-closed");
  });

  it("未绑定 session 时按 session_dir/ledger.yaml 读取，读不到即 block", async () => {
    const checker = createLedgerHasConfirmedChecker();
    const result = await checker.check(context({ session_dir: "/tmp/cord/definitely-missing" }));
    expect(result.result).toBe("block");
    expect(result.reason).toContain("fail-closed");
  });
});
