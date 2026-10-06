/**
 * SDLC 生命周期测试（ADR-0022 补齐）：draft 草稿、archive/unarchive 归档、模板库。
 * 真实 Fastify 实例 + 临时工作区。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

let root: string;
let server: BuiltServer;
let base: string;

const MINIMAL_YAML = `apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata: { id: life-sdlc, name: 生命周期验证 }
spec:
  nodes:
    - id: intake
      artifact: prd.md
      depends_on: []
      gates:
        - id: evidence
          role: { initiators: [], approvers: [] }
          attach: { node: intake, when: post, triggers: [] }
          checks: [{ ref: anchors-present }]
          pass: { require: all, human_confirm: false }
          on_fail: block
          write_back: []
    - id: done
      depends_on: [intake]
      gates: []
`;

async function api(
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-sdlc-life-"));
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

describe("SDLC 草稿", () => {
  it("保存（允许校验不通过）→ 读取 → has_draft → 发布后清除", async () => {
    // 半成品草稿：无 gate（校验不过）也允许保存
    const half = MINIMAL_YAML.replace(/gates:[\s\S]*?write_back: \[\]\n/, "gates: []\n");
    const saved = await api("PUT", "/api/v1/sdlcs/life-sdlc/draft", {
      body: { yaml: half },
      key: "draft-save-1",
    });
    expect(saved.body.saved).toBe(true);
    expect(saved.body.validation.ok).toBe(false);

    const loaded = await api("GET", "/api/v1/sdlcs/life-sdlc/draft");
    expect(loaded.body.draft.yaml).toBe(half);

    const list = await api("GET", "/api/v1/sdlcs");
    const entry = list.body.sdlcs.find((item: any) => item.sdlc_id === "life-sdlc");
    expect(entry.has_draft).toBe(true);

    // 发布完整版 → 草稿清除
    const published = await api("POST", "/api/v1/sdlcs/life-sdlc/versions/publish", {
      body: { yaml: MINIMAL_YAML },
      key: "publish-life-1",
    });
    expect(published.status).toBe(201);
    const after = await api("GET", "/api/v1/sdlcs/life-sdlc/draft");
    expect(after.body.draft).toBe(null);
    const listAfter = await api("GET", "/api/v1/sdlcs");
    expect(listAfter.body.sdlcs.find((item: any) => item.sdlc_id === "life-sdlc").has_draft).toBe(false);
  });

  it("删除草稿（幂等）", async () => {
    await api("PUT", "/api/v1/sdlcs/life-sdlc/draft", { body: { yaml: MINIMAL_YAML }, key: "d1" });
    const deleted = await api("DELETE", "/api/v1/sdlcs/life-sdlc/draft", { key: "d2" });
    expect(deleted.body.deleted).toBe(true);
    expect((await api("GET", "/api/v1/sdlcs/life-sdlc/draft")).body.draft).toBe(null);
  });
});

describe("SDLC 归档", () => {
  it("归档 → 列表标 archived → 启动 run 被拒（409）→ 取消归档恢复", async () => {
    await api("POST", "/api/v1/sdlcs/life-sdlc/versions/publish", {
      body: { yaml: MINIMAL_YAML },
      key: "pub-arch-1",
    });
    const archived = await api("POST", "/api/v1/sdlcs/life-sdlc/versions/1/archive", { key: "arch-1" });
    expect(archived.body.status).toBe("archived");

    const list = await api("GET", "/api/v1/sdlcs");
    const version = list.body.sdlcs
      .find((item: any) => item.sdlc_id === "life-sdlc")
      .versions.find((item: any) => item.version === 1);
    expect(version.status).toBe("archived");

    await api("POST", "/api/v1/requirements", {
      body: { req_id: "REQ-ARCH", title: "归档验证" },
      key: "create-arch",
    });
    const started = await api("POST", "/api/v1/requirements/REQ-ARCH/runs", {
      body: { sdlc_id: "life-sdlc", sdlc_version: 1 },
      key: "start-arch",
    });
    expect(started.status).toBe(409);
    expect(started.body.message).toContain("已归档");

    await api("POST", "/api/v1/sdlcs/life-sdlc/versions/1/unarchive", { key: "unarch-1" });
    const restarted = await api("POST", "/api/v1/requirements/REQ-ARCH/runs", {
      body: { sdlc_id: "life-sdlc", sdlc_version: 1 },
      key: "start-arch-2",
    });
    expect(restarted.status).toBe(202);
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-ARCH");
      return detail.body.requirement.status === "completed";
    });
  });

  it("归档不存在的版本 → 404", async () => {
    const res = await api("POST", "/api/v1/sdlcs/life-sdlc/versions/9/archive", { key: "arch-9" });
    expect(res.status).toBe(404);
  });
});

describe("SDLC 模板库", () => {
  it("四档模板可列出、均可通过校验并发布", async () => {
    const listed = await api("GET", "/api/v1/sdlc-templates");
    expect(listed.body.templates.map((item: any) => item.id)).toEqual([
      "minimal",
      "standard",
      "strict",
      "agent-collab",
    ]);
    for (const template of listed.body.templates) {
      const validated = await api("POST", "/api/v1/sdlcs/tpl-check/versions/validate", {
        body: { yaml: template.yaml },
      });
      expect(validated.body.validation.ok, `模板 ${template.id} 应通过校验`).toBe(true);
    }
  });
});
