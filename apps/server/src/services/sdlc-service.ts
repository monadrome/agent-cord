/**
 * SDLC 服务（ADR-0022）：SDLC = 现有 WorkflowDef 的文件化封装。
 * 存储：`cord/.sdlc/<sdlc_id>/v<N>.yaml`（发布版不可原地修改）+ `draft.yaml`（草稿）。
 * validate/publish 复用 workflow 模块的 parseWorkflow / topologicalOrder / findUnknownCheckers，
 * server 不实现第二份校验逻辑。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  createBuiltinRegistry,
  findUnknownCheckers,
  parseWorkflow,
  topologicalOrder,
  WorkflowLoadError,
  type WorkflowDef,
} from "agent-cord";
import type { SdlcSummary, SdlcValidationResult, SdlcVersionInfo } from "../contracts.js";
import { badRequest, notFound } from "../errors.js";

export const SDLC_DIR = ".sdlc";
export const DEFAULT_SDLC_ID = "simple-sdlc";
export const DEFAULT_SDLC_VERSION = 1;

/** 默认 SDLC（方案 §5）：至少一个证据 gate + 至少一个人工确认点（ADR-0022 决策 4） */
export const DEFAULT_SDLC: WorkflowDef = {
  apiVersion: "agent-cord.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: DEFAULT_SDLC_ID, name: "简单 SDLC" },
  spec: {
    nodes: [
      { id: "intake", artifact: "prd.md", depends_on: [], gates: [] },
      {
        id: "align",
        artifact: "adr.md",
        depends_on: ["intake"],
        gates: [
          {
            id: "evidence-required",
            role: { initiators: [], approvers: [] },
            attach: { node: "align", when: "post", triggers: [] },
            checks: [{ ref: "anchors-present" }],
            pass: { require: "all", human_confirm: false },
            on_fail: "block",
            write_back: [],
          },
        ],
      },
      { id: "plan", artifact: "plan.md", depends_on: ["align"], gates: [] },
      { id: "implement", depends_on: ["plan"], gates: [] },
      { id: "verify", artifact: "findings.md", depends_on: ["implement"], gates: [] },
      {
        id: "review",
        depends_on: ["verify"],
        gates: [
          {
            id: "human-review",
            role: { initiators: [], approvers: ["local-human"] },
            attach: { node: "review", when: "post", triggers: [] },
            checks: [{ ref: "anchors-present" }],
            pass: { require: "all", human_confirm: true },
            on_fail: "escalate",
            write_back: [],
          },
        ],
      },
      { id: "done", depends_on: ["review"], gates: [] },
    ],
  },
};

interface VersionedDef {
  sdlc_id: string;
  version: number;
  def: WorkflowDef;
  yaml: string;
  content_hash: string;
  published_at: string;
}

function hashContent(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function renderVersionFile(def: WorkflowDef, version: number, publishedAt: string): string {
  const body = stringifyYaml(def);
  const hash = hashContent(body);
  return [
    `# SDLC 发布版本 v${version}（ADR-0022：发布版本不可原地修改，修改请发新版本）`,
    `# content_hash: ${hash}`,
    `# published_at: ${publishedAt}`,
    body,
  ].join("\n");
}

function parseVersionHeader(text: string): { content_hash: string; published_at: string } {
  const hash = /^# content_hash: (\S+)$/m.exec(text)?.[1] ?? hashContent(text);
  const at = /^# published_at: (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { content_hash: hash, published_at: at };
}

export class SdlcService {
  private readonly dir: string;

  constructor(cordRoot: string) {
    this.dir = join(cordRoot, SDLC_DIR);
  }

  /** 幂等物化默认 SDLC（ADR-0022 决策 4：开箱可跑） */
  async ensureDefaults(): Promise<void> {
    const dir = join(this.dir, DEFAULT_SDLC_ID);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `v${DEFAULT_SDLC_VERSION}.yaml`);
    try {
      await readFile(file, "utf8");
    } catch {
      await writeFile(file, renderVersionFile(DEFAULT_SDLC, DEFAULT_SDLC_VERSION, new Date().toISOString()), "utf8");
    }
  }

  /** 校验：schema + 引用完整性 + 拓扑无环 + checker 可解析 + 至少一个 gate（ADR-0022 决策 5） */
  validate(yaml: string): SdlcValidationResult {
    const issues: string[] = [];
    let def: WorkflowDef | null = null;
    try {
      def = parseWorkflow(yaml, { source: "<api>" });
      topologicalOrder(def);
    } catch (error) {
      if (error instanceof WorkflowLoadError) issues.push(...error.issues);
      else issues.push(error instanceof Error ? error.message : String(error));
    }
    if (def !== null) {
      for (const name of findUnknownCheckers(def, createBuiltinRegistry())) {
        issues.push(`checker 引用不可解析：${name}`);
      }
      const gateCount = def.spec.nodes.reduce((sum, node) => sum + node.gates.length, 0);
      if (gateCount === 0) issues.push("流程未声明任何 gate：至少需要一个证据 gate（fail-closed）");
    }
    return {
      ok: issues.length === 0,
      issues,
      content_hash: issues.length === 0 ? hashContent(yaml) : null,
    };
  }

  /** 发布：先校验，再递增版本号落盘；已发布版本不可改（ADR-0022 决策 3） */
  async publish(sdlcId: string, yaml: string): Promise<{ version: number; content_hash: string }> {
    const validation = this.validate(yaml);
    if (!validation.ok || validation.content_hash === null) {
      throw badRequest("SDLC 校验失败，拒绝发布", validation.issues);
    }
    const dir = join(this.dir, sdlcId);
    await mkdir(dir, { recursive: true });
    const latest = await this.latestVersion(sdlcId);
    const version = latest + 1;
    const def = parseWorkflow(yaml, { source: "<api>" });
    await writeFile(join(dir, `v${version}.yaml`), renderVersionFile(def, version, new Date().toISOString()), "utf8");
    return { version, content_hash: validation.content_hash };
  }

  async list(): Promise<SdlcSummary[]> {
    let entries: string[] = [];
    try {
      entries = (await readdir(this.dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
    const out: SdlcSummary[] = [];
    for (const sdlcId of entries) {
      const versions: SdlcVersionInfo[] = [];
      for (const file of await readdir(join(this.dir, sdlcId))) {
        const matched = /^v(\d+)\.yaml$/.exec(file);
        if (matched?.[1] === undefined) continue;
        const text = await readFile(join(this.dir, sdlcId, file), "utf8");
        const header = parseVersionHeader(text);
        versions.push({
          version: Number.parseInt(matched[1], 10),
          status: "published",
          content_hash: header.content_hash,
          published_at: header.published_at,
        });
      }
      versions.sort((a, b) => a.version - b.version);
      let name = sdlcId;
      const latest = versions[versions.length - 1];
      if (latest !== undefined) {
        try {
          const def = await this.loadDef(sdlcId, latest.version);
          name = def.metadata.name ?? sdlcId;
        } catch {
          // 名称展示失败不阻断列表
        }
      }
      out.push({ sdlc_id: sdlcId, name, builtin: sdlcId === DEFAULT_SDLC_ID, has_draft: false, versions });
    }
    return out;
  }

  /** 读取指定版本（缺省最新）的定义；不存在 → 404 */
  async get(sdlcId: string, version?: number): Promise<VersionedDef> {
    const resolved = version ?? (await this.latestVersion(sdlcId));
    if (resolved === 0) throw notFound(`SDLC "${sdlcId}" 不存在任何发布版本`);
    const file = join(this.dir, sdlcId, `v${resolved}.yaml`);
    let yaml: string;
    try {
      yaml = await readFile(file, "utf8");
    } catch {
      throw notFound(`SDLC "${sdlcId}" 的版本 v${resolved} 不存在`);
    }
    const header = parseVersionHeader(yaml);
    return {
      sdlc_id: sdlcId,
      version: resolved,
      def: parseWorkflow(yaml, { source: file }),
      yaml,
      content_hash: header.content_hash,
      published_at: header.published_at,
    };
  }

  private async loadDef(sdlcId: string, version: number): Promise<WorkflowDef> {
    return parseWorkflow(await readFile(join(this.dir, sdlcId, `v${version}.yaml`), "utf8"), {
      source: `${sdlcId}/v${version}.yaml`,
    });
  }

  private async latestVersion(sdlcId: string): Promise<number> {
    let files: string[] = [];
    try {
      files = await readdir(join(this.dir, sdlcId));
    } catch {
      return 0;
    }
    let latest = 0;
    for (const file of files) {
      const matched = /^v(\d+)\.yaml$/.exec(file);
      if (matched?.[1] !== undefined) latest = Math.max(latest, Number.parseInt(matched[1], 10));
    }
    return latest;
  }
}
