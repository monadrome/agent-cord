/**
 * server API 测试（ADR-0021）：真实 Fastify 实例 + 临时工作区，覆盖
 * 创建需求 / 幂等键重放 / 默认 SDLC run / 人工 gate 决策 / SSE 回放 / 重启恢复 / SDLC 校验发布 / doctor。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

let root: string;
let server: BuiltServer;
let base: string;

async function listen(): Promise<void> {
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  base = `http://127.0.0.1:${address.port}`;
}

async function close(): Promise<void> {
  await server.app.close();
  server.index.close();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-server-"));
  await listen();
});

afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

interface ApiResponse {
  status: number;
  body: Record<string, any>;
}

async function api(
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<ApiResponse> {
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

/** 轮询直到条件满足（run 在后台推进，测试以事件流投影为准） */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function createRequirement(reqId: string, title: string, key: string): Promise<ApiResponse> {
  return api("POST", "/api/v1/requirements", { body: { req_id: reqId, title }, key });
}

/** 跑完一个默认 SDLC 需求直到 review 人工 gate 挂起，返回审批 */
async function runUntilHumanGate(reqId: string): Promise<Record<string, any>> {
  const started = await api("POST", `/api/v1/requirements/${reqId}/runs`, { body: {}, key: `run-${reqId}` });
  expect(started.status).toBe(202);
  let approval: Record<string, any> | undefined;
  await waitFor(async () => {
    const res = await api("GET", `/api/v1/requirements/${reqId}/approvals`);
    approval = res.body["approvals"][0];
    return approval !== undefined;
  });
  return approval as Record<string, any>;
}

describe("健康与 SDLC", () => {
  it("health 返回服务信息", async () => {
    const res = await api("GET", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["service"]).toBe("agent-cord-server");
  });

  it("默认 SDLC 开箱可列（simple-sdlc v1 published）", async () => {
    const res = await api("GET", "/api/v1/sdlcs");
    expect(res.status).toBe(200);
    const sdlc = res.body["sdlcs"].find((s: Record<string, any>) => s["sdlc_id"] === "simple-sdlc");
    expect(sdlc).toBeDefined();
    expect(sdlc["versions"][0]["version"]).toBe(1);
    expect(sdlc["versions"][0]["status"]).toBe("published");
  });

  it("doctor 在 server 初始化的工作区全绿", async () => {
    const res = await api("POST", "/api/v1/doctor");
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
  });

  it("validate 拒绝非法 SDLC（环 / 未知 checker / 无 gate），publish 拒绝未通过校验的定义", async () => {
    const bad = await api("POST", "/api/v1/sdlcs/x-sdlc/versions/validate", {
      body: {
        yaml: [
          "apiVersion: agent-cord.dev/v1alpha1",
          "kind: Workflow",
          "metadata: { id: x-sdlc }",
          "spec:",
          "  nodes:",
          "    - id: a",
          "      depends_on: [b]",
          "    - id: b",
          "      depends_on: [a]",
        ].join("\n"),
      },
    });
    expect(bad.status).toBe(200);
    expect(bad.body["validation"]["ok"]).toBe(false);
    expect(bad.body["validation"]["issues"].length).toBeGreaterThan(0);

    const publishBad = await api("POST", "/api/v1/sdlcs/x-sdlc/versions/publish", {
      body: { yaml: "apiVersion: agent-cord.dev/v1alpha1\nkind: Workflow\nmetadata: {id: x}\nspec:\n  nodes:\n    - id: a" },
      key: "publish-bad",
    });
    expect(publishBad.status).toBe(400);
  });

  it("publish 新 SDLC 并可用于启动 run", async () => {
    const yaml = [
      "apiVersion: agent-cord.dev/v1alpha1",
      "kind: Workflow",
      "metadata: { id: mini-sdlc, name: 迷你 SDLC }",
      "spec:",
      "  nodes:",
      "    - id: only",
      "      gates:",
      "        - id: evidence",
      "          role: { initiators: [], approvers: [] }",
      "          attach: { node: only, when: post, triggers: [] }",
      "          checks: [{ ref: anchors-present }]",
      "          pass: { require: all, human_confirm: false }",
      "          on_fail: block",
    ].join("\n");
    const validated = await api("POST", "/api/v1/sdlcs/mini-sdlc/versions/validate", { body: { yaml } });
    expect(validated.body["validation"]["ok"]).toBe(true);

    const published = await api("POST", "/api/v1/sdlcs/mini-sdlc/versions/publish", { body: { yaml }, key: "pub-1" });
    expect(published.status).toBe(201);
    expect(published.body["version"]).toBe(1);

    await createRequirement("REQ-MINI", "迷你流程需求", "create-mini");
    const started = await api("POST", "/api/v1/requirements/REQ-MINI/runs", {
      body: { sdlc_id: "mini-sdlc", sdlc_version: 1 },
      key: "run-mini",
    });
    expect(started.status).toBe(202);
    await waitFor(async () => {
      const run = await api("GET", `/api/v1/runs/${started.body["run"]["run_id"]}`);
      return run.body["run"]["status"] === "completed";
    });
  });
});

describe("需求与幂等", () => {
  it("创建需求必须携带 Idempotency-Key；同键重放不产生重复事件", async () => {
    const missing = await api("POST", "/api/v1/requirements", { body: { title: "无键" } });
    expect(missing.status).toBe(400);
    expect(missing.body["code"]).toBe("bad_request");

    const first = await createRequirement("REQ-IDEM", "幂等测试", "idem-1");
    expect(first.status).toBe(201);
    expect(first.body["event_id"]).toBeDefined();

    const replay = await createRequirement("REQ-IDEM", "幂等测试", "idem-1");
    expect(replay.status).toBe(201);
    expect(replay.body["event_id"]).toBe(first.body["event_id"]);

    const events = await api("GET", "/api/v1/requirements/REQ-IDEM/events");
    expect(events.body["events"].length).toBe(1);
  });

  it("重复 req_id 返回 409", async () => {
    await createRequirement("REQ-DUP", "重复", "dup-1");
    const dup = await api("POST", "/api/v1/requirements", { body: { req_id: "REQ-DUP", title: "重复" }, key: "dup-2" });
    expect(dup.status).toBe(409);
  });

  it("快照文档可读写（living 文档）", async () => {
    await createRequirement("REQ-DOC", "文档", "doc-1");
    const updated = await api("PUT", "/api/v1/requirements/REQ-DOC/docs/prd", {
      body: { content: "# PRD\n\n目标：验证文档读写。" },
      key: "doc-put-1",
    });
    expect(updated.status).toBe(200);
    const read = await api("GET", "/api/v1/requirements/REQ-DOC/docs/prd");
    expect(read.body["content"]).toContain("验证文档读写");
  });
});

describe("默认 SDLC 端到端", () => {
  it("创建需求 → 启动 run → 人工 gate 挂起 → 决策放行 → 完成 → 账本一致", async () => {
    await createRequirement("REQ-E2E", "端到端", "e2e-create");

    // 在途 run 重复启动 → 409（确定性：等 run 登记在途后再发）
    const started = await api("POST", "/api/v1/requirements/REQ-E2E/runs", { body: {}, key: "run-e2e" });
    expect(started.status).toBe(202);
    const dup = await api("POST", "/api/v1/requirements/REQ-E2E/runs", { body: {}, key: "run-dup" });
    expect(dup.status).toBe(409);

    let approval: Record<string, any> | undefined;
    await waitFor(async () => {
      const res = await api("GET", "/api/v1/requirements/REQ-E2E/approvals");
      approval = res.body["approvals"][0];
      return approval !== undefined;
    });
    expect(approval!["node_id"]).toBe("review");
    expect(approval!["options"]).toContain("确认放行");

    // 非法选项 → 409
    const badChoice = await api(
      "POST",
      `/api/v1/requirements/REQ-E2E/approvals/${approval["approval_id"]}/decide`,
      { body: { choice: "随便" }, key: "decide-bad" },
    );
    expect(badChoice.status).toBe(409);

    const decided = await api(
      "POST",
      `/api/v1/requirements/REQ-E2E/approvals/${approval["approval_id"]}/decide`,
      { body: { choice: "确认放行" }, key: "decide-1" },
    );
    expect(decided.status).toBe(200);
    expect(decided.body["event_id"]).toBeDefined();

    await waitFor(async () => {
      const timeline = await api("GET", "/api/v1/requirements/REQ-E2E/timeline");
      return timeline.body["timeline"]["nodes"].every((n: Record<string, any>) => n["status"] === "exited");
    });

    const detail = await api("GET", "/api/v1/requirements/REQ-E2E");
    expect(detail.body["requirement"]["status"]).toBe("completed");

    const ledger = await api("GET", "/api/v1/requirements/REQ-E2E/ledger");
    expect(ledger.status).toBe(200);
    expect(ledger.body["projection_version"]).toBe(ledger.body["ledger"]["output_hash"]);

    const timeline = await api("GET", "/api/v1/requirements/REQ-E2E/timeline");
    const review = timeline.body["timeline"]["nodes"].find((n: Record<string, any>) => n["node_id"] === "review");
    expect(review["gates"][0]["human_confirmed"]).toBe(true);
  });

  it("人工拒绝 → 流程 blocked", async () => {
    await createRequirement("REQ-REJ", "拒绝", "rej-create");
    const approval = await runUntilHumanGate("REQ-REJ");
    await api("POST", `/api/v1/requirements/REQ-REJ/approvals/${approval["approval_id"]}/decide`, {
      body: { choice: "拒绝放行" },
      key: "rej-decide",
    });
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-REJ");
      return detail.body["requirement"]["status"] === "blocked";
    });
  });
});

describe("SSE", () => {
  it("订阅收到全量回放；Last-Event-ID 跳过已见事件；新事件实时推送", async () => {
    await createRequirement("REQ-SSE", "流", "sse-create");

    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/requirements/REQ-SSE/events/stream`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen: Array<{ id: string; data: Record<string, any> }> = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (id !== undefined && data !== undefined) seen.push({ id, data: JSON.parse(data) });
        }
      }
    })();

    // 回放：session.created（seq=1）
    await waitFor(async () => seen.length >= 1);
    expect(seen[0]!.id).toBe("1");
    expect(seen[0]!.data["type"]).toBe("session.created");

    // 实时：启动 run 后应收到 workflow.node.entered
    await api("POST", "/api/v1/requirements/REQ-SSE/runs", { body: {}, key: "sse-run" });
    await waitFor(async () => seen.some((event) => event.data["type"] === "workflow.node.entered"));
    controller.abort();
    await pump.catch(() => undefined);

    // Last-Event-ID=1：不回放 seq=1
    const res2 = await fetch(`${base}/api/v1/requirements/REQ-SSE/events/stream`, {
      headers: { "last-event-id": "1" },
    });
    const reader2 = res2.body!.getReader();
    const text = await Promise.race([
      (async () => {
        const { value } = await reader2.read();
        return new TextDecoder().decode(value);
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 2000)),
    ]);
    if (text.length > 0) {
      const firstId = /^id: (\d+)$/m.exec(text)?.[1];
      expect(Number(firstId)).toBeGreaterThan(1);
    }
    await reader2.cancel();
  });
});

describe("重启恢复（ADR-0021 决策 5/6）", () => {
  it("server 重启后：需求从事件流恢复，挂起审批可决策并自动续跑至完成", async () => {
    await createRequirement("REQ-RESTART", "重启", "restart-create");
    const approval = await runUntilHumanGate("REQ-RESTART");

    // 模拟进程重启：关旧实例（在途 run 消失），同工作区开新实例
    await close();
    await listen();

    const list = await api("GET", "/api/v1/requirements");
    const found = list.body["requirements"].find((r: Record<string, any>) => r["req_id"] === "REQ-RESTART");
    expect(found).toBeDefined();
    expect(found["status"]).toBe("waiting_human");
    expect(found["pending_approvals"]).toBe(1);

    const approvals = await api("GET", "/api/v1/requirements/REQ-RESTART/approvals");
    expect(approvals.body["approvals"][0]["approval_id"]).toBe(approval["approval_id"]);

    const decided = await api(
      "POST",
      `/api/v1/requirements/REQ-RESTART/approvals/${approval["approval_id"]}/decide`,
      { body: { choice: "确认放行" }, key: "restart-decide" },
    );
    expect(decided.status).toBe(200);

    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-RESTART");
      return detail.body["requirement"]["status"] === "completed";
    });
    const detail = await api("GET", "/api/v1/requirements/REQ-RESTART");
    expect(detail.body["requirement"]["event_count"]).toBeGreaterThan(0);
  });

  it("派生索引删除后可重建（runs 登记丢失不影响事件流事实）", async () => {
    await createRequirement("REQ-REBUILD", "重建", "rebuild-create");
    const approval = await runUntilHumanGate("REQ-REBUILD");
    await close();

    // 删除派生索引后重启
    await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    await listen();

    const approvals = await api("GET", "/api/v1/requirements/REQ-REBUILD/approvals");
    expect(approvals.body["approvals"].length).toBe(1);
    const decided = await api(
      "POST",
      `/api/v1/requirements/REQ-REBUILD/approvals/${approval["approval_id"]}/decide`,
      { body: { choice: "确认放行" }, key: "rebuild-decide" },
    );
    expect(decided.status).toBe(200);
    await waitFor(async () => {
      const detail = await api("GET", "/api/v1/requirements/REQ-REBUILD");
      return detail.body["requirement"]["status"] === "completed";
    });
  });
});
