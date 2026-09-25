/**
 * 控制台 API 客户端集成测试（真实 server + 临时工作区）：
 * 用 src/api.ts 的 client 函数跑关键流程 —— health → 创建需求 → 启动默认 run → 轮询人工 gate →
 * 决策放行 → 轮询至 completed → 读账本 / 时间线 / 事件断言；并覆盖幂等键复用、错误形状、
 * 文档读写、SDLC 校验/发布。前端不做状态机推导，断言以 server 投影为准。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { StreamedEvent } from "@agent-cord/server/contracts";
import { ApiClientError, createClient, subscribeEvents, type ApiClient } from "../src/api.js";

let root: string;
let server: BuiltServer;
let client: ApiClient;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-console-"));
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  client = createClient(`http://127.0.0.1:${address.port}`);
});

afterEach(async () => {
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

/** 轮询直到条件满足（run 在后台推进，以事件流投影为准） */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("console API client：默认 SDLC 闭环", () => {
  it("health → 创建需求 → 启动 run → 人工 gate 决策 → completed → 账本/时间线一致", async () => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.service).toBe("agent-cord-server");
    expect(health.cord_root).toBe(join(root, "cord"));
    expect(health.request_id.length).toBeGreaterThan(0);

    // 创建需求：一次用户动作一个幂等键
    const key = globalThis.crypto.randomUUID();
    const created = await client.createRequirement({ req_id: "REQ-CONSOLE", title: "控制台闭环" }, key);
    expect(created.requirement.req_id).toBe("REQ-CONSOLE");
    expect(created.requirement.status).toBe("idle");
    expect(created.event_id.length).toBeGreaterThan(0);

    // 同键重放不产生第二个事件（同一次动作的重试复用同一键）
    const replay = await client.createRequirement({ req_id: "REQ-CONSOLE", title: "控制台闭环" }, key);
    expect(replay.event_id).toBe(created.event_id);

    const list = await client.listRequirements();
    expect(list.requirements.map((item) => item.req_id)).toContain("REQ-CONSOLE");

    // 启动默认 SDLC run
    const started = await client.startRun("REQ-CONSOLE");
    expect(started.run.status).toBe("running");
    expect(started.run.sdlc_id).toBe("simple-sdlc");

    // 轮询审批直到 review 节点的人工 gate 挂起
    let approval = (await client.getApprovals("REQ-CONSOLE")).approvals[0];
    await waitFor(async () => {
      approval = (await client.getApprovals("REQ-CONSOLE")).approvals[0];
      return approval !== undefined;
    });
    expect(approval?.node_id).toBe("review");
    expect(approval?.kind).toBe("human_confirm");
    expect(approval?.options).toContain("确认放行");

    // 审批面板的 detail 投影此时应处于等待人工
    const waiting = await client.getRequirement("REQ-CONSOLE");
    expect(waiting.requirement.status).toBe("waiting_human");
    expect(waiting.requirement.pending_approvals).toBe(1);
    expect(waiting.requirement.docs.prd).toBe(true);

    const decided = await client.decideApproval("REQ-CONSOLE", approval!.approval_id, "确认放行");
    expect(decided.decided).toBe(true);
    expect(decided.event_id.length).toBeGreaterThan(0);

    await waitFor(async () => {
      const detail = await client.getRequirement("REQ-CONSOLE");
      return detail.requirement.status === "completed";
    });

    const afterDecide = await client.getApprovals("REQ-CONSOLE");
    expect(afterDecide.approvals).toHaveLength(0);

    // 账本投影：projection_version 与 output_hash 一致
    const ledger = await client.getLedger("REQ-CONSOLE");
    expect(ledger.projection_version).toBe(ledger.ledger.output_hash);
    expect(Array.isArray(ledger.ledger.entries)).toBe(true);

    // 时间线：全部节点 exited，review gate 由人工确认
    const timeline = await client.getTimeline("REQ-CONSOLE");
    expect(timeline.timeline.sdlc_id).toBe("simple-sdlc");
    expect(timeline.timeline.nodes.length).toBeGreaterThan(0);
    expect(timeline.timeline.nodes.every((node) => node.status === "exited")).toBe(true);
    const review = timeline.timeline.nodes.find((node) => node.node_id === "review");
    expect(review?.gates[0]?.human_confirmed).toBe(true);
    expect(review?.gates[0]?.result).toBe("pass");
    expect(timeline.timeline.run?.status).toBe("completed");

    // 事件：REST 快照与 SSE 同源；after_seq 过滤生效
    const all = await client.getEvents("REQ-CONSOLE");
    expect(all.events.length).toBeGreaterThan(0);
    expect(all.events.map((event) => event.seq)).toEqual([...all.events.map((event) => event.seq)].sort((a, b) => a - b));
    expect(all.events.some((event) => event.type === "human.decision.recorded")).toBe(true);
    const tail = await client.getEvents("REQ-CONSOLE", 1);
    expect(tail.events.every((event) => event.seq > 1)).toBe(true);
    expect(tail.events.length).toBe(all.events.length - 1);

    // 投票投影：默认 SDLC 未使用投票，接口返回空列表而不是报错
    expect((await client.getVotes("REQ-CONSOLE")).votes).toEqual([]);

    // 工作台汇总
    const dashboard = await client.dashboard();
    expect(dashboard.requirements.total).toBe(1);
    expect(dashboard.requirements.by_status.completed).toBe(1);
    expect(dashboard.pending_approvals).toHaveLength(0);

    // run 结束后账本已重建：doctor 全绿（事件流与投影对账一致）
    const doctor = await client.doctor();
    expect(doctor.ok).toBe(true);
    expect(doctor.sessions).toContain("REQ-CONSOLE");
  });

  it("拒绝放行 → 需求 blocked（审批选项直接转发给 server）", async () => {
    await client.createRequirement({ req_id: "REQ-REJECT", title: "拒绝" });
    await client.startRun("REQ-REJECT");

    let approval = (await client.getApprovals("REQ-REJECT")).approvals[0];
    await waitFor(async () => {
      approval = (await client.getApprovals("REQ-REJECT")).approvals[0];
      return approval !== undefined;
    });

    await client.decideApproval("REQ-REJECT", approval!.approval_id, "拒绝放行");
    await waitFor(async () => {
      const detail = await client.getRequirement("REQ-REJECT");
      return detail.requirement.status === "blocked";
    });

    const dashboard = await client.dashboard();
    expect(dashboard.requirements.by_status.blocked).toBe(1);
  });
});

describe("console API client：文档 / 事件 / SDLC / 错误", () => {
  it("快照文档：四个占位文档都可读可写；未知需求返回 404", async () => {
    await client.createRequirement({ req_id: "REQ-DOC", title: "文档", prd: "# PRD\n\n目标：验证控制台读写。" });

    const prd = await client.readDoc("REQ-DOC", "prd");
    expect(prd.doc).toBe("prd");
    expect(prd.content).toContain("验证控制台读写");

    // cord init 为四个快照文档生成占位内容，因此文档 tab 总能直接打开编辑
    for (const doc of ["plan", "adr", "findings"] as const) {
      const page = await client.readDoc("REQ-DOC", doc);
      expect(page.doc).toBe(doc);
      expect(page.content.length).toBeGreaterThan(0);
    }

    const updated = await client.writeDoc("REQ-DOC", "plan", "# 计划\n\n1. 写测试");
    expect(updated.updated).toBe(true);
    expect((await client.readDoc("REQ-DOC", "plan")).content).toContain("写测试");

    // 未知需求 → 404：页面据此提示
    const missing = await client.readDoc("REQ-NOPE", "prd").then(
      () => null,
      (cause: unknown) => cause as ApiClientError,
    );
    expect(missing).toBeInstanceOf(ApiClientError);
    expect(missing?.status).toBe(404);
    expect(missing?.code).toBe("not_found");
  });

  it("未知需求返回带 code/message 的 ApiClientError", async () => {
    await expect(client.getRequirement("REQ-NOPE")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 404,
      code: "not_found",
    });
  });

  it("非法决策选项返回 409 conflict（前端据此提示）", async () => {
    await client.createRequirement({ req_id: "REQ-BAD", title: "非法选项" });
    await client.startRun("REQ-BAD");
    let approval = (await client.getApprovals("REQ-BAD")).approvals[0];
    await waitFor(async () => {
      approval = (await client.getApprovals("REQ-BAD")).approvals[0];
      return approval !== undefined;
    });

    const error = await client
      .decideApproval("REQ-BAD", approval!.approval_id, "随便选一个")
      .then(() => null)
      .catch((cause: unknown) => cause as ApiClientError);
    expect(error?.status).toBe(409);
    expect(error?.code).toBe("conflict");
  });

  it("SDLC：list → 查看版本 YAML → 校验（问题可读）→ 发布新版本", async () => {
    const sdlcs = await client.listSdlcs();
    const list = sdlcs.sdlcs.find((item) => item.sdlc_id === "simple-sdlc");
    expect(list?.builtin).toBe(true);
    expect(list?.versions[0]?.version).toBe(1);

    const version = await client.getSdlcVersion("simple-sdlc", 1);
    expect(version.content_hash.startsWith("sha256:")).toBe(true);
    expect(version.yaml).toContain("simple-sdlc");

    const badYaml = [
      "apiVersion: agent-cord.dev/v1alpha1",
      "kind: Workflow",
      "metadata: { id: console-x }",
      "spec:",
      "  nodes:",
      "    - id: a",
      "      depends_on: [b]",
      "    - id: b",
      "      depends_on: [a]",
    ].join("\n");
    const bad = await client.validateSdlc("console-x", badYaml);
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.issues.length).toBeGreaterThan(0);
    expect(bad.validation.content_hash).toBeNull();

    const goodYaml = [
      "apiVersion: agent-cord.dev/v1alpha1",
      "kind: Workflow",
      "metadata: { id: console-sdlc, name: 控制台流程 }",
      "spec:",
      "  nodes:",
      "    - id: only",
      "      artifact: prd.md",
      "      gates:",
      "        - id: evidence",
      "          role: { initiators: [], approvers: [] }",
      "          attach: { node: only, when: post, triggers: [] }",
      "          checks: [{ ref: anchors-present }]",
      "          pass: { require: all, human_confirm: false }",
      "          on_fail: block",
    ].join("\n");
    const good = await client.validateSdlc("console-sdlc", goodYaml);
    expect(good.validation.ok).toBe(true);

    const published = await client.publishSdlc("console-sdlc", goodYaml);
    expect(published.version).toBe(1);
    expect(published.content_hash).toBe(good.validation.content_hash);

    // 未校验通过的 YAML 直接发布 → 400（details 是 issues 数组）
    const publishError = await client.publishSdlc("console-x", badYaml).then(
      () => null,
      (cause: unknown) => cause as ApiClientError,
    );
    expect(publishError?.status).toBe(400);
    expect(Array.isArray(publishError?.details)).toBe(true);

    const refreshed = await client.listSdlcs();
    expect(refreshed.sdlcs.find((item) => item.sdlc_id === "console-sdlc")?.versions).toHaveLength(1);
  });

  it("doctor：返回检查明细（新建需求后投影尚未重建，doctor 会如实报漂移）", async () => {
    await client.createRequirement({ req_id: "REQ-DOCTOR", title: "体检" });
    const doctor = await client.doctor();
    expect(doctor.sessions).toContain("REQ-DOCTOR");
    expect(doctor.checks.length).toBeGreaterThan(0);
    for (const check of doctor.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
    // 检查名带 session 前缀（如 session(REQ-DOCTOR).ledger_projection_matches）
    expect(doctor.checks.some((check) => check.name.endsWith("ledger_projection_matches"))).toBe(true);
    // 说明：session 创建后 ledger.yaml 仍是 init 时的空投影，未 rebuildLedger 前该项为 false；
    // run 跑完（launch 末尾 rebuildLedger）后 doctor 才全绿 —— 见闭环测试中的 ok 断言。
    expect(doctor.fixed).toEqual([]);
  });
});

describe("SSE 封装（node 无 EventSource，注入假实现验证包装层）", () => {
  /** 最小 EventSource 替身：记录 URL，可手动派发 message 事件 */
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly url: string;
    closed = false;
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    close(): void {
      this.closed = true;
    }
  }

  const original = (globalThis as { EventSource?: unknown }).EventSource;

  afterEach(() => {
    if (original === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
    else (globalThis as { EventSource?: unknown }).EventSource = original;
    FakeEventSource.instances = [];
  });

  it("缺少 EventSource 时通过 onError 显式报错，close 仍可安全调用", () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
    const errors: unknown[] = [];
    const close = subscribeEvents("REQ-SSE", () => undefined, (error) => errors.push(error), "http://127.0.0.1:1");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("EventSource");
    expect(() => close()).not.toThrow();
  });

  it("订阅 URL 指向事件流端点；data JSON 解析为事件；close 关闭连接", () => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown as typeof EventSource;

    const received: StreamedEvent[] = [];
    const errors: unknown[] = [];
    const close = subscribeEvents(
      "REQ-SSE/1",
      (event) => received.push(event),
      (error) => errors.push(error),
      "http://127.0.0.1:7250/",
    );

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("http://127.0.0.1:7250/api/v1/requirements/REQ-SSE%2F1/events/stream");

    const event: StreamedEvent = {
      event_id: "01M3BDXKW5A1CT1M87J3R5QRK2",
      session_id: "REQ-SSE/1",
      seq: 1,
      prev_event_hash: null,
      type: "session.created",
      schema_version: "1",
      timestamp: "2026-09-25T00:00:00.000Z",
      actor: { kind: "human", id: "local-human" },
      correlation_id: null,
      payload: { title: "测试" },
      source: { adapter: "console-server" },
    };
    source?.emit("message", { data: JSON.stringify(event) });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("session.created");
    expect(errors).toHaveLength(0);

    // 非 JSON 数据 → onError，不静默吞掉
    source?.emit("message", { data: "not-json" });
    expect(errors).toHaveLength(1);

    close();
    expect(source?.closed).toBe(true);
  });
});
