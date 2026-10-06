/**
 * 内置 SDLC 模板库（ADR-0014 注意点 9：模板分档；ADR-0023 决策 7：默认 SDLC 不挂执行体，
 * 挂执行体的流程走模板显式 opt-in）。
 *
 * 模板是发布前的起点：console 载入后可自由修改，validate/publish 走同一管线。
 */
import { stringify as stringifyYaml } from "yaml";
import type { WorkflowDef } from "agent-cord";
import { DEFAULT_SDLC } from "./sdlc-service.js";

export interface SdlcTemplate {
  id: string;
  name: string;
  description: string;
  yaml: string;
}

function render(def: WorkflowDef): string {
  return stringifyYaml(def);
}

function gate(id: string, node: string, checks: WorkflowDef["spec"]["nodes"][number]["gates"][number]["checks"], humanConfirm: boolean, onFail: "block" | "warn" | "escalate" = "block") {
  return {
    id,
    role: { initiators: [], approvers: humanConfirm ? ["local-human"] : [] },
    attach: { node, when: "post" as const, triggers: [] },
    checks,
    pass: { require: "all" as const, human_confirm: humanConfirm },
    on_fail: onFail,
    write_back: [],
  };
}

const MINIMAL: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "my-minimal-sdlc", name: "轻量流程" },
  spec: {
    nodes: [
      { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
      {
        id: "review",
        depends_on: ["intake"],
        gates: [gate("evidence-required", "review", [{ ref: "anchors-present" }], true, "escalate")],
      },
      { id: "done", depends_on: ["review"], gates: [] },
    ],
  },
};

const STRICT: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "my-strict-sdlc", name: "严格流程" },
  spec: {
    nodes: [
      {
        id: "intake",
        artifact: "prd.md",
        depends_on: [],
        gates: [gate("prd-ready", "intake", [{ ref: "file-nonempty", with: { path: "prd.md", min_bytes: 200 } }], false)],
      },
      {
        id: "align",
        artifact: "adr.md",
        depends_on: ["intake"],
        gates: [
          gate("evidence-strong", "align", [{ ref: "anchors-min-count", with: { min: 2 } }], false),
          gate("adr-decision", "align", [{ ref: "doc-has-section", with: { path: "adr.md", heading: "决策" } }], false),
        ],
      },
      {
        id: "plan",
        artifact: "plan.md",
        depends_on: ["align"],
        gates: [gate("plan-ready", "plan", [{ ref: "file-nonempty", with: { path: "plan.md", min_bytes: 100 } }], false)],
      },
      { id: "implement", depends_on: ["plan"], gates: [] },
      {
        id: "verify",
        artifact: "findings.md",
        depends_on: ["implement"],
        gates: [gate("verify-report", "verify", [{ ref: "file-nonempty", with: { path: "findings.md" } }], false)],
      },
      {
        id: "review",
        depends_on: ["verify"],
        gates: [gate("human-review", "review", [{ ref: "anchors-present" }], true, "escalate")],
      },
      { id: "done", depends_on: ["review"], gates: [] },
    ],
  },
};

const AGENT_COLLAB: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "my-agent-sdlc", name: "Agent 协作流程" },
  spec: {
    nodes: [
      { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
      {
        id: "align",
        artifact: "adr.md",
        depends_on: ["intake"],
        run: { agent: "claude", readonly: false },
        gates: [gate("adr-written", "align", [{ ref: "file-nonempty", with: { path: "adr.md" } }], false)],
      },
      {
        id: "plan",
        artifact: "plan.md",
        depends_on: ["align"],
        run: { agent: "claude", readonly: false },
        gates: [gate("plan-written", "plan", [{ ref: "file-nonempty", with: { path: "plan.md" } }], false)],
      },
      {
        id: "implement",
        depends_on: ["plan"],
        run: { agent: "claude", readonly: false, timeout_ms: 1_800_000 },
        gates: [],
      },
      {
        id: "verify",
        artifact: "findings.md",
        depends_on: ["implement"],
        run: { agent: "claude", readonly: false },
        gates: [gate("verify-written", "verify", [{ ref: "file-nonempty", with: { path: "findings.md" } }], false)],
      },
      {
        id: "review",
        depends_on: ["verify"],
        gates: [gate("human-review", "review", [{ ref: "anchors-present" }], true, "escalate")],
      },
      { id: "done", depends_on: ["review"], gates: [] },
    ],
  },
};

/** 内置模板清单（顺序 = console 展示顺序；standard 即默认 simple-sdlc 的内容） */
export function listSdlcTemplates(): SdlcTemplate[] {
  return [
    {
      id: "minimal",
      name: "轻量",
      description: "intake → review → done：一个人工确认点 + 证据 gate，适合小改动",
      yaml: render(MINIMAL),
    },
    {
      id: "standard",
      name: "标准",
      description: "默认 simple-sdlc 同构：七节点 + 证据 gate + review 人工确认",
      yaml: render(DEFAULT_SDLC),
    },
    {
      id: "strict",
      name: "严格",
      description: "每个产物节点挂参数化 checker（文件非空/小节/锚点数量）+ 人工确认",
      yaml: render(STRICT),
    },
    {
      id: "agent-collab",
      name: "Agent 协作",
      description: "节点挂 run 执行体（需 agents.yaml 或本机 agent CLI）+ 产物验收 gate + 人工终审",
      yaml: render(AGENT_COLLAB),
    },
  ];
}
